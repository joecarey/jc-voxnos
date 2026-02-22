// Claude-powered voice assistant app with tool support

import type { VoxnosApp, AppContext, SpeechInput, AppResponse } from '../core/types.js';
import { toolRegistry } from '../tools/registry.js';

// Retryable HTTP status codes for Anthropic API calls
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Fetch with exponential backoff retry for transient Anthropic API failures.
 * Uses shorter delays than cognos (500ms, 2s) to minimize caller wait time.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const RETRY_DELAYS_MS = [500, 2000]; // 2 retries: 0.5s, 2s
  for (let attempt = 0; attempt < 1 + RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
    try {
      const response = await fetch(url, init);
      if (!response.ok && RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        continue;
      }
      return response;
    } catch (networkErr) {
      if (attempt < RETRY_DELAYS_MS.length) continue;
      throw networkErr;
    }
  }
  throw new Error('Anthropic API max retries exceeded');
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

/**
 * Extract complete sentences from a text buffer.
 * A sentence ends at . ! ? followed by whitespace (or end of string for the remainder).
 */
function extractCompleteSentences(buffer: string): { complete: string[]; remainder: string } {
  const sentences: string[] = [];
  const re = /[.!?][\s]+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const sentence = buffer.slice(last, match.index + 1).trim();
    if (sentence) sentences.push(sentence);
    last = match.index + match[0].length;
  }
  return { complete: sentences, remainder: buffer.slice(last) };
}

// Simple in-memory conversation storage with TTL
const CONVERSATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const conversations = new Map<string, { messages: Message[]; lastActive: number }>();

function pruneConversations(): void {
  const now = Date.now();
  for (const [id, data] of conversations.entries()) {
    if (now - data.lastActive > CONVERSATION_TTL_MS) {
      conversations.delete(id);
    }
  }
}

export class ClaudeAssistant implements VoxnosApp {
  id = 'claude-assistant';
  name = 'Claude Voice Assistant';

  async onStart(context: AppContext): Promise<AppResponse> {
    pruneConversations();
    conversations.set(context.callId, { messages: [], lastActive: Date.now() });

    console.log(JSON.stringify({
      event: 'call_start',
      callId: context.callId,
      from: context.from,
      app: this.id,
      timestamp: new Date().toISOString(),
    }));

    return {
      speech: {
        text: this.getTimeBasedGreeting(),
      },
      prompt: true,
    };
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    const userMessage = input.text.trim();

    // Check for goodbye intent
    if (this.isGoodbye(userMessage)) {
      return {
        speech: {
          text: 'Goodbye! Have a great day.',
        },
        hangup: true,
      };
    }

    // Get conversation history
    const entry = conversations.get(context.callId);
    const messages = entry?.messages ?? [];

    // Add user message to history
    messages.push({
      role: 'user',
      content: userMessage,
    });

    // Call Claude API (with tool support)
    const assistantResponse = await this.callClaude(context, messages);

    // Update conversation with refreshed timestamp
    conversations.set(context.callId, { messages, lastActive: Date.now() });

    return {
      speech: {
        text: assistantResponse,
      },
      prompt: true,  // Keep listening
    };
  }

  async onEnd(context: AppContext): Promise<void> {
    conversations.delete(context.callId);
    console.log(JSON.stringify({
      event: 'call_end',
      callId: context.callId,
      timestamp: new Date().toISOString(),
    }));
  }

  /**
   * V2 streaming path: yields one sentence at a time as Claude generates the response.
   * Uses the Anthropic streaming API for the final text answer; tool calls remain non-streaming.
   * Sentences are yielded immediately upon detection of a sentence boundary, enabling
   * routes.ts to TTS sentence 1 and return to FreeClimb before sentences 2+ are ready.
   */
  async *streamSpeech(context: AppContext, input: SpeechInput): AsyncGenerator<string, void, undefined> {
    const userMessage = input.text.trim();

    if (this.isGoodbye(userMessage)) {
      yield 'Goodbye! Have a great day.';
      return;
    }

    const entry = conversations.get(context.callId);
    const messages: Message[] = entry ? [...entry.messages] : [];
    messages.push({ role: 'user', content: userMessage });

    yield* this.streamClaude(context, messages);

    conversations.set(context.callId, { messages, lastActive: Date.now() });
  }

  /**
   * Core streaming Claude call with tool-use support.
   * Streams the Anthropic API response, yielding sentences as they arrive.
   * If tool_use blocks are detected, executes tools (non-streamingly) and loops.
   */
  private async *streamClaude(context: AppContext, messages: Message[]): AsyncGenerator<string, void, undefined> {
    const systemPrompt = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Keep responses concise (2-3 sentences max)
- Use natural, conversational language
- Avoid special characters, URLs, or formatting
- If asked complex questions, summarize briefly and offer to elaborate
- Be friendly and helpful
- When using tools, explain what you found in a natural way`;

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
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 300,
          system: systemPrompt,
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

        this.trackDailyCost(context.env.RATE_LIMIT_KV, totalInputTokens, totalOutputTokens).catch(() => {});
        break;
      }
    }
  }

  private async callClaude(context: AppContext, history: Message[]): Promise<string> {
    const systemPrompt = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Keep responses concise (2-3 sentences max)
- Use natural, conversational language
- Avoid special characters, URLs, or formatting
- If asked complex questions, summarize briefly and offer to elaborate
- Be friendly and helpful
- When using tools, explain what you found in a natural way`;

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
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 300,
            system: systemPrompt,
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
      this.trackDailyCost(context.env.RATE_LIMIT_KV, totalInputTokens, totalOutputTokens).catch(() => {});

      return finalText || 'I didn\'t catch that. Could you repeat?';

    } catch (error) {
      console.error('Error calling Claude API:', error);
      return 'I\'m experiencing technical difficulties. Please try again.';
    }
  }

  private getTimeBasedGreeting(): string {
    // Get current time in Central Time (America/Chicago)
    const now = new Date();
    const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const hour = centralTime.getHours();

    let greeting: string;
    if (hour >= 5 && hour < 12) {
      greeting = 'Good morning';
    } else if (hour >= 12 && hour < 18) {
      greeting = 'Good afternoon';
    } else {
      greeting = 'Good evening';
    }

    return `${greeting}! How can I help you today?`;
  }

  private isGoodbye(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('goodbye') ||
           lower.includes('bye') ||
           lower.includes('see you') ||
           lower.includes('hang up') ||
           lower === 'exit' ||
           lower === 'quit';
  }

  private async trackDailyCost(kv: KVNamespace, inputTokens: number, outputTokens: number): Promise<void> {
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
}
