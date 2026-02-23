// Claude-powered voice assistant app with tool support

import type { VoxnosApp, AppContext, SpeechInput, AppResponse, StreamChunk } from '../core/types.js';
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

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are a helpful voice assistant. Your responses will be converted to speech, so:
- Keep responses concise (1-2 sentences for simple answers, 3 max for complex ones)
- Use natural, conversational language
- Avoid special characters, URLs, or formatting
- If asked complex questions, summarize briefly and offer to elaborate
- Be friendly and helpful
- When using tools, state the result once clearly — do not restate or paraphrase the same fact
- Never repeat information you already said in a different form
- Always use tools to fetch real-time data (weather, stocks, etc.) — even for follow-up questions about different locations or topics; never answer from training data when a tool is available`;

// Phrases used for tool-call acknowledgments — randomized so repeat callers don't hear the same line
export const FILLER_PHRASES = [
  'One moment while I check on that.',
  'Let me look that up for you.',
  'Sure, let me find that information.',
  'Just a second while I pull that up.',
  'Hold on while I check on that.',
  'Let me get that for you.',
];

// Goodbye phrases — randomized for variety
export const GOODBYE_PHRASES = [
  'Goodbye! Have a great day.',
  'Great talking with you. Talk to you soon!',
  'It was great chatting with you. Goodbye!',
  'Hope I was helpful. Have a wonderful day!',
  'Goodbye! Feel free to call back anytime.',
  "Sure thing. I'm here if you need me.",
];

// Conversation storage via KV — reliable across Cloudflare Worker isolates.
// In-memory Maps are scoped to a single isolate; KV is consistent regardless of which
// isolate handles a given request, so context is never lost between call turns.
const CONVERSATION_TTL_SECONDS = 15 * 60; // 15 minutes — longer than any realistic call

async function getMessages(kv: KVNamespace, callId: string): Promise<Message[]> {
  const data = await kv.get(`conv:${callId}`, 'json') as Message[] | null;
  return data ?? [];
}

async function saveMessages(kv: KVNamespace, callId: string, messages: Message[]): Promise<void> {
  await kv.put(`conv:${callId}`, JSON.stringify(messages), { expirationTtl: CONVERSATION_TTL_SECONDS });
}

export class ClaudeAssistant implements VoxnosApp {
  id = 'claude-assistant';
  name = 'Claude Voice Assistant';

  async onStart(context: AppContext): Promise<AppResponse> {
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
      const goodbye = GOODBYE_PHRASES[Math.floor(Math.random() * GOODBYE_PHRASES.length)];
      return {
        speech: { text: goodbye },
        hangup: true,
      };
    }

    const messages = await getMessages(context.env.RATE_LIMIT_KV, context.callId);
    messages.push({ role: 'user', content: userMessage });

    const assistantResponse = await this.callClaude(context, messages);

    await saveMessages(context.env.RATE_LIMIT_KV, context.callId, messages);

    return {
      speech: {
        text: assistantResponse,
      },
      prompt: true,  // Keep listening
    };
  }

  async onEnd(context: AppContext): Promise<void> {
    await context.env.RATE_LIMIT_KV.delete(`conv:${context.callId}`);
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
  async *streamSpeech(context: AppContext, input: SpeechInput): AsyncGenerator<StreamChunk, void, undefined> {
    const userMessage = input.text.trim();

    if (this.isGoodbye(userMessage)) {
      const idx = Math.floor(Math.random() * GOODBYE_PHRASES.length);
      yield { text: GOODBYE_PHRASES[idx], hangup: true, cacheKey: `goodbye-${idx}` };
      return;
    }

    const messages = await getMessages(context.env.RATE_LIMIT_KV, context.callId);
    messages.push({ role: 'user', content: userMessage });

    for await (const sentence of this.streamClaude(context, messages)) {
      // Filler phrases have stable cache keys so routes.ts can serve them without re-generating TTS
      const fillerIdx = FILLER_PHRASES.indexOf(sentence);
      if (fillerIdx >= 0) {
        yield { text: sentence, cacheKey: `filler-${fillerIdx}` };
      } else {
        yield { text: sentence };
      }
    }

    await saveMessages(context.env.RATE_LIMIT_KV, context.callId, messages);
  }

  /**
   * Core streaming Claude call with tool-use support.
   * Streams the Anthropic API response, yielding sentences as they arrive.
   * If tool_use blocks are detected, executes tools (non-streamingly) and loops.
   */
  private async *streamClaude(context: AppContext, messages: Message[]): AsyncGenerator<string, void, undefined> {

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
          model: CLAUDE_MODEL,
          max_tokens: 300,
          system: SYSTEM_PROMPT,
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
                  const filler = FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
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

        this.trackDailyCost(context.env.RATE_LIMIT_KV, totalInputTokens, totalOutputTokens).catch(() => {});
        break;
      }
    }
  }

  private async callClaude(context: AppContext, history: Message[]): Promise<string> {

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
            model: CLAUDE_MODEL,
            max_tokens: 300,
            system: SYSTEM_PROMPT,
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
