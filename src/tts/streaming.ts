// Streaming TTS pipeline — background processor for sentence-by-sentence audio.
// Runs inside ctx.waitUntil() after the route returns the first Play response.
// Stores each sentence's audio in KV and marks the stream as done when finished.

import type { Env, StreamChunk } from '../engine/types.js';
import { sanitizeForTTS } from './helpers.js';
import { callTTS } from './helpers.js';

export interface StreamOpts {
  /** Skip filler chunks (cacheKey starts with "filler-") to prevent double-filler
   *  when a pre-filler was already played at the route layer. */
  skipFillers?: boolean;
  /** Called when a hangup chunk is encountered (e.g. goodbye).
   *  Typically fires app.onEnd() for conversation cleanup. */
  onHangup?: () => Promise<void>;
  /** Called after the stream finishes with all sentence texts and whether the call ended.
   *  Used by CDR to record the full assistant response. */
  onStreamComplete?: (sentences: string[], hangup: boolean) => Promise<void>;
  /** Per-app Google TTS voice name (e.g. "en-US-Chirp3-HD-Leda"). */
  voice?: string;
}

export async function processRemainingStream(
  sentenceStream: AsyncGenerator<StreamChunk, void, undefined>,
  callKey: string,
  env: Env,
  startIndex: number,
  opts?: StreamOpts,
): Promise<void> {
  // Signal /continue that the stream is alive — without this marker, /continue
  // can't distinguish "stream hasn't produced anything yet" from "stream is done"
  // and may return TranscribeUtterance prematurely (e.g. during slow cognos calls).
  await env.RATE_LIMIT_KV.put(`${callKey}:pending`, '1', { expirationTtl: 120 });

  let n = startIndex;
  const collectedSentences: string[] = [];
  let didHangup = false;
  try {
    for await (const chunk of sentenceStream) {
      if (opts?.skipFillers && chunk.cacheKey?.startsWith('filler-')) continue;
      n++;
      const safeSentence = sanitizeForTTS(chunk.text);
      if (!safeSentence) continue;
      collectedSentences.push(safeSentence);
      const audio = await callTTS(safeSentence, env, opts?.voice);
      const id = crypto.randomUUID();
      await env.RATE_LIMIT_KV.put(`tts:${id}`, audio, { expirationTtl: 120 });
      await env.RATE_LIMIT_KV.put(`${callKey}:${n}`, id, { expirationTtl: 120 });

      if (chunk.hangup) {
        didHangup = true;
        // Signal /continue to hang up after playing this sentence
        await env.RATE_LIMIT_KV.put(`${callKey}:hangup`, String(n), { expirationTtl: 120 });
        if (opts?.onHangup) await opts.onHangup();
        break;
      }
    }
  } catch (err) {
    console.error('processRemainingStream error:', err);
  } finally {
    await env.RATE_LIMIT_KV.put(`${callKey}:done`, '1', { expirationTtl: 120 });
    if (opts?.onStreamComplete) {
      await opts.onStreamComplete(collectedSentences, didHangup).catch(() => {});
    }
  }
}
