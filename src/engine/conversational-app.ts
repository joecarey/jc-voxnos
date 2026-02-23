// ConversationalApp — LLM-conversational app pattern.
// Handles the Claude turn cycle: goodbye detection, history management,
// streaming with filler tagging. Apps just provide personality config.

import type { AppContext, SpeechInput, AppResponse, StreamChunk } from './types.js';
import type { ClaudeConfig } from '../services/claude-client.js';
import { BaseApp } from './base-app.js';
import { streamClaude, callClaude, CLAUDE_MODEL } from '../services/claude-client.js';
import { isGoodbye } from './speech-utils.js';
import { compressToolResults, getMessages, saveMessages } from '../services/conversation.js';

export interface AssistantConfig {
  id: string;
  name: string;
  systemPrompt: string;
  greetings: string[];
  fillers: string[];
  goodbyes: string[];
  retries?: string[];
  model?: string;
  /** Tool names this app can use (resolved against ToolRegistry). When undefined, all tools are available. */
  tools?: string[];
}

export class ConversationalApp extends BaseApp {
  private readonly config: AssistantConfig;
  private readonly claudeConfig: ClaudeConfig;

  constructor(config: AssistantConfig) {
    super({
      id: config.id,
      name: config.name,
      fillerPhrases: config.fillers,
      retryPhrases: config.retries,
    });
    this.config = config;
    this.claudeConfig = {
      systemPrompt: config.systemPrompt,
      model: config.model ?? CLAUDE_MODEL,
      fillerPhrases: config.fillers,
      toolNames: config.tools,
    };
  }

  protected getGreeting(): string {
    const { greetings } = this.config;
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  async onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse> {
    const userMessage = input.text.trim();

    if (isGoodbye(userMessage)) {
      const { goodbyes } = this.config;
      return {
        speech: { text: goodbyes[Math.floor(Math.random() * goodbyes.length)] },
        hangup: true,
      };
    }

    const messages = await getMessages(context.env.RATE_LIMIT_KV, context.callId);
    messages.push({ role: 'user', content: userMessage });

    const assistantResponse = await callClaude(this.claudeConfig, context, messages);

    compressToolResults(messages);
    await saveMessages(context.env.RATE_LIMIT_KV, context.callId, messages);

    return {
      speech: { text: assistantResponse },
      prompt: true,
    };
  }

  async *streamSpeech(context: AppContext, input: SpeechInput): AsyncGenerator<StreamChunk, void, undefined> {
    const userMessage = input.text.trim();

    if (isGoodbye(userMessage)) {
      const { goodbyes } = this.config;
      const idx = Math.floor(Math.random() * goodbyes.length);
      yield { text: goodbyes[idx], hangup: true, cacheKey: `goodbye-${idx}` };
      return;
    }

    const messages = await getMessages(context.env.RATE_LIMIT_KV, context.callId);
    messages.push({ role: 'user', content: userMessage });

    for await (const sentence of streamClaude(this.claudeConfig, context, messages)) {
      const fillerIdx = this.config.fillers.indexOf(sentence);
      if (fillerIdx >= 0) {
        yield { text: sentence, cacheKey: `filler-${fillerIdx}` };
      } else {
        yield { text: sentence };
      }
    }

    compressToolResults(messages);
    await saveMessages(context.env.RATE_LIMIT_KV, context.callId, messages);
  }
}
