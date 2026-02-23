// FreeClimb PerCL command builder
// Converts app responses into FreeClimb JSON commands

import type { AppResponse } from '../core/types.js';
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
  Play?: {
    file: string;
  };
  TranscribeUtterance?: {
    actionUrl: string;
    playBeep: boolean;
    record: {
      maxLengthSec: number;
      rcrdTerminationSilenceTimeMs: number;
    };
  };
  Pause?: { length: number };
  Hangup?: Record<string, never>;
  OutDial?: {
    destination: string;
    callConnectUrl: string;
  };
  Redirect?: {
    actionUrl: string;
  };
}

/**
 * Sanitize text before sending to TTS.
 * Strips SSML/HTML tags and entities that could cause unexpected TTS behavior
 * if injected via user speech → Claude response path.
 */
export function sanitizeForTTS(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')    // strip SSML/HTML tags
    .replace(/&[a-z]+;/gi, '')  // strip HTML entities (&amp; &lt; etc.)
    .trim()
    .slice(0, 2000);            // cap length — FreeClimb Say has practical limits
}

/**
 * Default TTS provider (FreeClimb-mediated ElevenLabs, used when TTS_MODE=freeclimb)
 */
const DEFAULT_TTS_PROVIDER = new ElevenLabsProvider({
  voiceId: 'EXAVITQu4vr4xnSDxMaL',  // Sarah voice
  languageCode: 'en',
});

/**
 * Convert app response to FreeClimb PerCL commands.
 *
 * TTS mode selection:
 * - If response.audioUrls is set (google|11labs streaming path): Play commands used directly.
 * - If ttsProvider.getPlayUrl exists (DirectElevenLabsProvider, TTS_MODE=11labs): emits Play
 *   command pointing to /tts endpoint — HMAC-signed URL.
 * - Otherwise: emits Say command with optional engine config — FreeClimb-mediated TTS (fallback).
 *
 * @param response - App response from onStart or onSpeech handler
 * @param baseUrl - Base URL for webhook callbacks
 * @param ttsProvider - TTS provider (defaults to FreeClimb-mediated ElevenLabs)
 * @returns Array of FreeClimb PerCL commands
 */
export async function buildPerCL(
  response: AppResponse,
  baseUrl: string,
  ttsProvider: TTSProvider = DEFAULT_TTS_PROVIDER,
): Promise<PerCLCommand[]> {
  const percl: PerCLCommand[] = [];
  const origin = new URL(baseUrl).origin;

  // V2: pre-generated audio URLs (streaming path) — use directly
  if (response.audioUrls?.length) {
    for (const url of response.audioUrls) {
      percl.push({ Play: { file: url } });
    }
  } else if (response.speech?.text) {
    const safeText = sanitizeForTTS(response.speech.text);
    if (safeText) {
      if (ttsProvider.getPlayUrl) {
        // Direct path (TTS_MODE=11labs): HMAC-signed Play URL via /tts endpoint
        const playUrl = await ttsProvider.getPlayUrl(safeText, origin);
        if (playUrl) {
          percl.push({ Play: { file: playUrl } });
        }
      } else {
        // FreeClimb-mediated path (TTS_MODE=freeclimb): Say with engine config
        const engineConfig = ttsProvider.getEngineConfig(safeText);
        percl.push({
          Say: {
            text: safeText,
            ...(engineConfig ? { engine: engineConfig } : {}),
          },
        });
      }
    }
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

  // Hang up if requested — brief pause first so the goodbye phrase doesn't cut off abruptly
  if (response.hangup) {
    percl.push({ Pause: { length: 300 } });
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
