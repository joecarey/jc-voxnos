// BaseApp — abstract base class for all voxnos app types.
// Handles shared plumbing: call lifecycle logging, KV cleanup.
// Subclasses implement the core conversational behavior.

import type { VoxnosApp, AppContext, SpeechInput, AppResponse, StreamChunk } from './types.js';

export interface BaseAppConfig {
  id: string;
  name: string;
  fillerPhrases?: string[];
  retryPhrases?: string[];
}

export abstract class BaseApp implements VoxnosApp {
  readonly id: string;
  readonly name: string;
  readonly fillerPhrases?: string[];
  readonly retryPhrases?: string[];

  constructor(config: BaseAppConfig) {
    this.id = config.id;
    this.name = config.name;
    this.fillerPhrases = config.fillerPhrases;
    this.retryPhrases = config.retryPhrases;
  }

  /** Subclasses provide the greeting text. */
  protected abstract getGreeting(context: AppContext): string;

  async onStart(context: AppContext): Promise<AppResponse> {
    console.log(JSON.stringify({
      event: 'call_start',
      callId: context.callId,
      from: context.from,
      app: this.id,
      timestamp: new Date().toISOString(),
    }));

    return {
      speech: { text: this.getGreeting(context) },
      prompt: true,
    };
  }

  abstract onSpeech(context: AppContext, input: SpeechInput): Promise<AppResponse>;

  async onEnd(context: AppContext): Promise<void> {
    await context.env.RATE_LIMIT_KV.delete(`conv:${context.callId}`);
    console.log(JSON.stringify({
      event: 'call_end',
      callId: context.callId,
      timestamp: new Date().toISOString(),
    }));
  }

  // Optional — subclasses override for streaming support
  streamSpeech?(context: AppContext, input: SpeechInput): AsyncGenerator<StreamChunk, void, undefined>;
}
