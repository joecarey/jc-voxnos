// Conversation engine — platform-neutral turn-cycle orchestration.
// Makes the "what happens this turn" decisions, returns a TurnResult.
// Routes are a thin telephony adapter that converts TurnResult to PerCL + TTS.

import type { VoxnosApp, AppContext, SpeechInput, AppResponse, StreamChunk } from './types.js';
import { isGoodbye } from './speech-utils.js';

/** Default retry phrases used when an app doesn't declare its own. */
export const DEFAULT_RETRY_PHRASES = [
  "I didn't catch that. Could you please repeat?",
  "Sorry, I missed that. Could you say it again?",
  "I didn't quite hear you. Could you repeat that?",
  "Pardon? Could you say that again?",
];

// --- TurnResult: platform-neutral description of what happened this turn ---

export type TurnResult =
  | NoInputResult
  | ResponseResult
  | StreamResult;

export interface NoInputResult {
  type: 'no-input';
  retryPhrase: string;
}

export interface ResponseResult {
  type: 'response';
  speech: AppResponse;
  cleanup?: () => Promise<void>;
}

export interface StreamResult {
  type: 'stream';
  stream: AsyncGenerator<StreamChunk, void, undefined>;
  preFiller?: { phrase: string; fillerIndex: number };
  skipFillers: boolean;
  cleanup?: () => Promise<void>;
}

// --- Engine options ---

export interface TurnOpts {
  /** Whether the platform supports streaming TTS (e.g. google or 11labs mode). */
  streaming: boolean;
  /** Probability of playing an immediate filler before Claude responds (0-1). */
  preFillerProbability: number;
}

// --- Engine entry point ---

export async function processTurn(
  app: VoxnosApp,
  context: AppContext,
  input: SpeechInput,
  opts: TurnOpts,
): Promise<TurnResult> {
  // 1. No input — caller said nothing
  if (!input.text || input.text.trim() === '') {
    const phrases = app.retryPhrases?.length ? app.retryPhrases : DEFAULT_RETRY_PHRASES;
    const idx = Math.floor(Math.random() * phrases.length);
    return { type: 'no-input', retryPhrase: phrases[idx] };
  }

  const cleanup = app.onEnd ? () => app.onEnd!(context) : undefined;

  // 2. Streaming path — app has streamSpeech and platform supports streaming TTS
  if (opts.streaming && app.streamSpeech) {
    const fillers = app.fillerPhrases;
    const usePreFiller = fillers?.length && !isGoodbye(input.text) && Math.random() < opts.preFillerProbability;

    if (usePreFiller) {
      const fillerIdx = Math.floor(Math.random() * fillers.length);
      const stream = app.streamSpeech(context, input);
      return {
        type: 'stream',
        stream,
        preFiller: { phrase: fillers[fillerIdx], fillerIndex: fillerIdx },
        skipFillers: true,
        cleanup,
      };
    }

    const stream = app.streamSpeech(context, input);
    return {
      type: 'stream',
      stream,
      skipFillers: false,
      cleanup,
    };
  }

  // 3. Non-streaming path — call onSpeech directly
  const response = await app.onSpeech(context, input);
  return {
    type: 'response',
    speech: response,
    cleanup: response.hangup ? cleanup : undefined,
  };
}
