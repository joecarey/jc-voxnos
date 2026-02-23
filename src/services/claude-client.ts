// Shared Claude API integration — streaming, non-streaming, and cost tracking.

import type { AppContext } from '../engine/types.js';
import type { ContentBlock, Message } from './conversation.js';
import { fetchWithRetry, extractCompleteSentences } from '../engine/speech-utils.js';
import { toolRegistry } from '../tools/registry.js';

/** Per-app configuration for Claude API calls. */
export interface ClaudeConfig {
  systemPrompt: string;
  model: string;
  fillerPhrases: string[];
}

/** Default Claude model for voice apps. */
export const CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Core streaming Claude call with tool-use support.
 * Streams the Anthropic API response, yielding sentences as they arrive.
 * If tool_use blocks are detected, executes tools (non-streamingly) and loops.
 */
export async function* streamClaude(
  config: ClaudeConfig,
  context: AppContext,
  messages: Message[],
): AsyncGenerator<string, void, undefined> {

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let apiCalls = 0;

  while (true) {
    const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': context.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 300,
        system: config.systemPrompt,
        messages,
        tools: toolRegistry.getDefinitions(),
        stream: true,
      }),
    });

    if (!response.ok) {
      console.error(JSON.stringify({ event: 'claude_stream_error', callId: context.callId, status: response.status, timestamp: new Date().toISOString() }));
      yield "I'm sorry, I'm having trouble processing that right now. Could you try again?";
      return;
    }

    // Parse the SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let sentenceBuffer = '';
    let hasToolUse = false;
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, any> }> = [];
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInputJson = '';
    const yieldedSentences: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });

      // Process complete SSE events (separated by \n\n)
      let boundary: number;
      while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
        const eventText = sseBuffer.slice(0, boundary);
        sseBuffer = sseBuffer.slice(boundary + 2);

        if (!eventText.trim()) continue;

        let eventData = '';
        for (const line of eventText.split('\n')) {
          if (line.startsWith('data: ')) {
            eventData = line.slice(6);
            break;
          }
        }

        if (!eventData || eventData === '[DONE]') continue;

        let event: any;
        try { event = JSON.parse(eventData); } catch { continue; }

        switch (event.type) {
          case 'message_start':
            inputTokens = event.message?.usage?.input_tokens ?? 0;
            break;

          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              hasToolUse = true;
              currentToolId = event.content_block.id ?? '';
              currentToolName = event.content_block.name ?? '';
              currentToolInputJson = '';
              // Yield filler immediately — we know a tool is coming before the stream finishes.
              // This fires ~300-600ms sooner than waiting for the full tool_use JSON to stream.
              if (yieldedSentences.length === 0) {
                const filler = config.fillerPhrases[Math.floor(Math.random() * config.fillerPhrases.length)];
                yield filler;
                yieldedSentences.push(filler);
              }
            }
            break;

          case 'content_block_delta':
            if (event.delta?.type === 'text_delta' && !hasToolUse) {
              sentenceBuffer += event.delta.text ?? '';
              const { complete, remainder } = extractCompleteSentences(sentenceBuffer);
              for (const sentence of complete) {
                if (sentence.trim()) {
                  yield sentence.trim();
                  yieldedSentences.push(sentence.trim());
                }
              }
              sentenceBuffer = remainder;
            } else if (event.delta?.type === 'input_json_delta') {
              currentToolInputJson += event.delta.partial_json ?? '';
            }
            break;

          case 'content_block_stop':
            if (hasToolUse && currentToolId) {
              let input: Record<string, any> = {};
              try { input = JSON.parse(currentToolInputJson || '{}'); } catch { /* empty input */ }
              toolUseBlocks.push({ id: currentToolId, name: currentToolName, input });
              currentToolId = '';
              currentToolName = '';
              currentToolInputJson = '';
            }
            break;

          case 'message_delta':
            outputTokens = event.usage?.output_tokens ?? 0;
            break;
        }
      }
    }

    apiCalls++;
    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;

    if (hasToolUse) {
      // Build assistant content (optional leading text + tool_use blocks)
      // Note: filler was already yielded at content_block_start above
      const assistantContent: ContentBlock[] = [
        ...(yieldedSentences.length > 0 ? [{ type: 'text' as const, text: yieldedSentences.join(' ') }] : []),
        ...toolUseBlocks.map(t => ({
          type: 'tool_use' as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })),
      ];

      const toolResults: ContentBlock[] = [];
      for (const tool of toolUseBlocks) {
        console.log(JSON.stringify({ event: 'tool_execute', callId: context.callId, tool: tool.name, timestamp: new Date().toISOString() }));
        const result = await toolRegistry.execute(tool.name, tool.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });
      }

      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user', content: toolResults });
      // Loop for the final text answer
    } else {
      // Pure text response — yield any remaining buffer content
      if (sentenceBuffer.trim()) {
        yield sentenceBuffer.trim();
        yieldedSentences.push(sentenceBuffer.trim());
      }

      const fullText = yieldedSentences.join(' ');
      if (fullText) {
        messages.push({ role: 'assistant', content: fullText });
      }

      console.log(JSON.stringify({
        event: 'claude_stream_complete',
        callId: context.callId,
        api_calls: apiCalls,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        sentences: yieldedSentences.length,
        timestamp: new Date().toISOString(),
      }));

      trackDailyCost(context.env.RATE_LIMIT_KV, totalInputTokens, totalOutputTokens).catch(() => {});
      break;
    }
  }
}

/**
 * Non-streaming Claude call with tool-use loop.
 * Used as V1 fallback when streaming is not available.
 */
export async function callClaude(
  config: ClaudeConfig,
  context: AppContext,
  history: Message[],
): Promise<string> {

  try {
    let continueLoop = true;
    let finalText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let apiCalls = 0;

    // Tool use may require multiple API calls
    while (continueLoop) {
      const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': context.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 300,
          system: config.systemPrompt,
          messages: history,
          tools: toolRegistry.getDefinitions(),
        }),
      });

      if (!response.ok) {
        console.error(JSON.stringify({ event: 'claude_api_error', callId: context.callId, status: response.status, timestamp: new Date().toISOString() }));
        return 'I\'m sorry, I\'m having trouble processing that right now. Could you try again?';
      }

      const data = await response.json() as {
        content: ContentBlock[];
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      apiCalls++;
      totalInputTokens += data.usage?.input_tokens ?? 0;
      totalOutputTokens += data.usage?.output_tokens ?? 0;

      // Process response content
      const assistantContent: ContentBlock[] = [];
      const toolResults: ContentBlock[] = [];

      for (const block of data.content) {
        if (block.type === 'text') {
          finalText = block.text || '';
          assistantContent.push(block);
        } else if (block.type === 'tool_use') {
          assistantContent.push(block);

          console.log(JSON.stringify({ event: 'tool_execute', callId: context.callId, tool: block.name, timestamp: new Date().toISOString() }));
          const toolResult = await toolRegistry.execute(block.name!, block.input!);

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id!,
            content: toolResult,
          });
        }
      }

      // Add assistant response to history
      history.push({
        role: 'assistant',
        content: assistantContent,
      });

      // If tools were used, add results and continue loop
      if (toolResults.length > 0) {
        history.push({
          role: 'user',
          content: toolResults,
        });
        continueLoop = true;
      } else {
        continueLoop = false;
      }
    }

    console.log(JSON.stringify({
      event: 'claude_turn_complete',
      callId: context.callId,
      api_calls: apiCalls,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      timestamp: new Date().toISOString(),
    }));

    // Fire-and-forget daily cost tracking
    trackDailyCost(context.env.RATE_LIMIT_KV, totalInputTokens, totalOutputTokens).catch(() => {});

    return finalText || 'I didn\'t catch that. Could you repeat?';

  } catch (error) {
    console.error('Error calling Claude API:', error);
    return 'I\'m experiencing technical difficulties. Please try again.';
  }
}

/** Increment daily Anthropic token usage counters in KV. */
export async function trackDailyCost(kv: KVNamespace, inputTokens: number, outputTokens: number): Promise<void> {
  const date = new Date().toISOString().split('T')[0];
  const key = `costs:voxnos:${date}`;

  const existing = await kv.get(key, 'json') as {
    input_tokens: number;
    output_tokens: number;
    requests: number;
  } | null;

  const updated = {
    input_tokens: (existing?.input_tokens ?? 0) + inputTokens,
    output_tokens: (existing?.output_tokens ?? 0) + outputTokens,
    requests: (existing?.requests ?? 0) + 1,
  };

  await kv.put(key, JSON.stringify(updated), { expirationTtl: 90 * 24 * 60 * 60 });
}
