// FreeClimb PerCL command builder
// Converts app responses into FreeClimb JSON commands

import type { TTSProvider, TTSEngineConfig } from '../tts/index.js';
import { ElevenLabsProvider } from '../tts/index.js';

/**
 * FreeClimb PerCL command types
 */
export interface PerCLCommand {
  Say?: {
    text: string;
    engine?: TTSEngineConfig;
  };
  TranscribeUtterance?: {
    actionUrl: string;
    playBeep: boolean;
    record: {
      maxLengthSec: number;
      rcrdTerminationSilenceTimeMs: number;
    };
  };
  Hangup?: Record<string, never>;
  OutDial?: {
    destination: string;
    callConnectUrl: string;
  };
}

/**
 * App response interface (matches AppResponse from core/types.ts)
 */
export interface AppResponse {
  speech?: {
    text: string;
  };
  prompt?: boolean;
  hangup?: boolean;
  transfer?: string;
}

/**
 * Default TTS provider (ElevenLabs with Sarah voice)
 */
const DEFAULT_TTS_PROVIDER = new ElevenLabsProvider({
  voiceId: 'EXAVITQu4vr4xnSDxMaL',  // Sarah voice
  languageCode: 'en',
});

/**
 * Convert app response to FreeClimb PerCL commands
 *
 * @param response - App response from onStart or onSpeech handler
 * @param baseUrl - Base URL for webhook callbacks
 * @param ttsProvider - Optional TTS provider (defaults to ElevenLabs/Sarah)
 * @returns Array of FreeClimb PerCL commands
 */
export function buildPerCL(
  response: AppResponse,
  baseUrl: string,
  ttsProvider: TTSProvider = DEFAULT_TTS_PROVIDER
): PerCLCommand[] {
  const percl: PerCLCommand[] = [];
  const origin = new URL(baseUrl).origin;

  // Say the response text
  if (response.speech?.text) {
    const engineConfig = ttsProvider.getEngineConfig(response.speech.text);
    const sayCommand: PerCLCommand = {
      Say: {
        text: response.speech.text,
        ...(engineConfig ? { engine: engineConfig } : {}),
      },
    };
    percl.push(sayCommand);
  }

  // If we should prompt for more speech, use TranscribeUtterance
  if (response.prompt) {
    percl.push({
      TranscribeUtterance: {
        actionUrl: `${origin}/conversation`,
        playBeep: false,
        record: {
          maxLengthSec: 25,
          rcrdTerminationSilenceTimeMs: 4000,
        },
      },
    });
  }

  // Hang up if requested
  if (response.hangup) {
    percl.push({ Hangup: {} });
  }

  // Transfer if requested
  if (response.transfer) {
    percl.push({
      OutDial: {
        destination: response.transfer,
        callConnectUrl: `${origin}/transfer`,
      },
    });
  }

  return percl;
}
