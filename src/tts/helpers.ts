// TTS helper functions — infrastructure shared by routes and streaming pipeline.
// Extracted from routes.ts to keep route handlers focused on telephony orchestration.

import type { Env } from '../engine/types.js';
import type { TTSProvider } from './types.js';
import { DirectElevenLabsProvider, FreeClimbDefaultProvider } from './freeclimb.js';
import { callElevenLabs, ELEVENLABS_VOICE_ID } from './elevenlabs.js';
import { callGoogleTTS, GOOGLE_TTS_VOICE } from './google.js';

/** Short voice identifier appended to all stable TTS cache keys.
 *  When the voice changes, URLs change and FreeClimb's HTTP cache is automatically busted. */
export function voiceSlug(env: Env): string {
  if (env.TTS_MODE === '11labs') return 'sarah';
  return GOOGLE_TTS_VOICE.split('-').pop()!.toLowerCase(); // "despina"
}

/** Derive a stable, URL-safe KV cache key for a greeting phrase. */
export function greetingCacheKey(text: string, slug: string): string {
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `greeting-${key}-${slug}`;
}

/** Call the active TTS provider (Google or ElevenLabs) for a text string. */
export function callTTS(text: string, env: Env): Promise<ArrayBuffer> {
  if (env.TTS_MODE === 'google') {
    return callGoogleTTS(text, env.GOOGLE_TTS_API_KEY!);
  }
  return callElevenLabs(text, env.ELEVENLABS_API_KEY!, undefined, env.ELEVENLABS_BASE_URL);
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

/** Return the appropriate TTSProvider for the current TTS_MODE. */
export function getTTSProvider(env: Env): TTSProvider {
  if (env.TTS_MODE === '11labs') {
    return new DirectElevenLabsProvider({
      voiceId: ELEVENLABS_VOICE_ID,
      signingSecret: env.TTS_SIGNING_SECRET,
    });
  }
  return new FreeClimbDefaultProvider();
}
