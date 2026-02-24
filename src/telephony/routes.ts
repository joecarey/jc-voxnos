// HTTP route handlers for voxnos platform.
// FreeClimb-specific adapter: converts engine TurnResults into PerCL + TTS.

import { registry } from '../engine/registry.js';
import type { Env, AppContext, AppResponse, SpeechInput, VoxnosApp } from '../engine/types.js';
import { processTurn } from '../engine/engine.js';
import type { TurnResult } from '../engine/engine.js';
import { buildPerCL, sanitizeForTTS } from './percl.js';
import { voiceSlug, greetingCacheKey, callTTS, getTTSProvider } from '../tts/helpers.js';
import { processRemainingStream } from '../tts/streaming.js';
import { createCallRecord, addTurn, endCallRecord } from '../services/cdr-store.js';

// Probability of playing an immediate acknowledgment filler before Claude responds.
// 0.5 = coin flip. Set to 0 to disable, 1 to always play.
const PRE_FILLER_PROBABILITY = 0.5;

/** Pre-generate TTS audio and set audioUrls on the response.
 *  'greeting' strategy: stable cache key derived from text content, 6hr TTL, cache-first.
 *  'response' strategy: UUID key, 120s TTL, no cache lookup (per-turn content varies). */
async function applyTTS(
  response: AppResponse, origin: string, env: Env,
  strategy: 'greeting' | 'response', voice?: string,
): Promise<void> {
  if ((env.TTS_MODE !== 'google' && env.TTS_MODE !== '11labs') || !response.speech?.text) return;
  const safeText = sanitizeForTTS(response.speech.text);
  if (!safeText) return;

  try {
    if (strategy === 'greeting') {
      const gId = greetingCacheKey(safeText, voiceSlug(env, voice));
      let audio = await env.RATE_LIMIT_KV.get(`tts:${gId}`, 'arrayBuffer');
      if (audio) {
        console.log(JSON.stringify({ event: 'greeting_cache_hit', key: gId, timestamp: new Date().toISOString() }));
      } else {
        audio = await callTTS(safeText, env, voice);
        await env.RATE_LIMIT_KV.put(`tts:${gId}`, audio, { expirationTtl: 6 * 60 * 60 });
        console.log(JSON.stringify({ event: 'greeting_cache_miss', key: gId, timestamp: new Date().toISOString() }));
      }
      response.audioUrls = [`${origin}/tts-cache?id=${gId}`];
    } else {
      const audio = await callTTS(safeText, env, voice);
      const id = crypto.randomUUID();
      await env.RATE_LIMIT_KV.put(`tts:${id}`, audio, { expirationTtl: 120 });
      response.audioUrls = [`${origin}/tts-cache?id=${id}`];
    }
  } catch (ttsErr) {
    console.error(JSON.stringify({ event: `${strategy}_tts_fail`, error: String(ttsErr), timestamp: new Date().toISOString() }));
  }
}

/**
 * FreeClimb call webhook - handles incoming calls
 */
export async function handleIncomingCall(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  try {
    const body = await request.json() as {
      callId: string;
      from: string;
      to: string;
      callStatus: string;
    };

    console.log(JSON.stringify({ event: 'call_incoming', callId: body.callId, from: body.from, to: body.to, timestamp: new Date().toISOString() }));

    // Route to appropriate app based on phone number
    const app = registry.getForNumber(body.to);

    if (!app) {
      console.log(JSON.stringify({ event: 'call_no_app', to: body.to, timestamp: new Date().toISOString() }));
      return Response.json([
        { Say: { text: 'No application configured for this number.' } },
        { Hangup: {} },
      ]);
    }

    // Initialize app context
    const context: AppContext = {
      env,
      callId: body.callId,
      from: body.from,
      to: body.to,
    };

    const response = await app.onStart(context);

    // CDR: record call start + greeting (fire-and-forget)
    if (env.DB) {
      const db = env.DB;
      const greetingText = response.speech?.text ?? '';
      ctx?.waitUntil(
        createCallRecord(db, { callId: body.callId, appId: app.id, caller: body.from, callee: body.to })
          .then(() => addTurn(db, { callId: body.callId, turnType: 'greeting', speaker: 'system', content: greetingText }))
          .catch((err: unknown) => console.error('CDR write failed:', err)),
      );
    }

    // Pre-generate greeting audio for direct TTS modes (google, 11labs).
    // Falls through to FreeClimb Say if TTS fails.
    const origin = new URL(request.url).origin;
    await applyTTS(response, origin, env, 'greeting', app.voice);

    // Convert app response to FreeClimb PerCL
    const percl = await buildPerCL(response, request.url, getTTSProvider(env));

    // Fire onEnd cleanup if the greeting itself signals hangup (unlikely but correct)
    if (response.hangup && app.onEnd) {
      ctx?.waitUntil(app.onEnd(context));
    }

    return Response.json(percl, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in handleIncomingCall:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
    return Response.json([
      { Say: { text: 'Sorry, an error occurred. Please try again later.' } },
      { Hangup: {} },
    ], { status: 500 });
  }
}

/**
 * FreeClimb conversation webhook - handles each turn of dialogue.
 * Delegates turn-level decisions to the conversation engine, then converts
 * the platform-neutral TurnResult into FreeClimb PerCL + TTS.
 */
export async function handleConversation(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
  parsedBody?: Record<string, any>,
): Promise<Response> {
  type ConversationBody = {
    callId: string;
    from: string;
    to: string;
    recordingId?: string;
    recordingUrl?: string;
    transcript?: string;
    transcribeReason?: string;
    transcriptionDurationMs?: number;
  };
  try {
    const body = (parsedBody as ConversationBody | undefined) ?? await request.json() as ConversationBody;

    console.log(JSON.stringify({ event: 'conversation_turn', callId: body.callId, transcript_length: body.transcript?.length ?? 0, transcribeReason: body.transcribeReason, timestamp: new Date().toISOString() }));

    const db = env.DB;

    // CDR: detect caller hangup (FreeClimb sends transcribeReason=hangup on disconnect)
    if (body.transcribeReason === 'hangup' && !body.transcript) {
      if (db) ctx?.waitUntil(endCallRecord(db, body.callId, 'completed').catch((err: unknown) => console.error('CDR write failed:', err)));
      // Still process normally — app.onEnd will fire via the engine
    }

    // Build context early — needed by both transfer and normal paths
    const context: AppContext = {
      env,
      callId: body.callId,
      from: body.from,
      to: body.to,
    };
    const origin = new URL(request.url).origin;

    // --- Check for per-call app override (internal transfer from River, etc.) ---
    // Three KV keys: durable app override, one-shot pending flag, optional warm-transfer context
    const [callAppOverride, pendingFlag, transferContextRaw] = await Promise.all([
      env.RATE_LIMIT_KV.get(`call-app:${body.callId}`),
      env.RATE_LIMIT_KV.get(`call-app:${body.callId}:pending`),
      env.RATE_LIMIT_KV.get(`call-transfer-context:${body.callId}`),
    ]);

    let warmTransferInput: string | undefined;
    let transferredApp: VoxnosApp | undefined;

    if (callAppOverride && pendingFlag) {
      const targetApp = registry.get(callAppOverride);
      if (targetApp) {
        console.log(JSON.stringify({ event: 'call_transfer', callId: body.callId, to_app: callAppOverride, timestamp: new Date().toISOString() }));
        // Clean up transfer keys
        await Promise.all([
          env.RATE_LIMIT_KV.delete(`call-app:${body.callId}:pending`),
          env.RATE_LIMIT_KV.delete(`conv:${body.callId}`),
          transferContextRaw ? env.RATE_LIMIT_KV.delete(`call-transfer-context:${body.callId}`) : Promise.resolve(),
        ]);

        // Parse warm-transfer context
        let intent: string | undefined;
        if (transferContextRaw) {
          try { intent = (JSON.parse(transferContextRaw) as { intent?: string }).intent; } catch { /* ignore */ }
        }

        // Warm transfer: intent present + target supports streaming (ConversationalApp, not SurveyApp)
        if (intent && targetApp.streamSpeech) {
          console.log(JSON.stringify({ event: 'warm_transfer', callId: body.callId, to_app: callAppOverride, intent, timestamp: new Date().toISOString() }));
          // CDR: transfer turn + synthetic caller_speech
          if (db) {
            ctx?.waitUntil(
              addTurn(db, { callId: body.callId, turnType: 'transfer', speaker: 'system', content: `Transferred to ${targetApp.name}`, meta: { to_app: callAppOverride, warm: true, intent } })
                .then(() => addTurn(db, { callId: body.callId, turnType: 'caller_speech', speaker: 'caller', content: intent!, meta: { warm_transfer: true } }))
                .catch((err: unknown) => console.error('CDR write failed:', err)),
            );
          }
          // Fall through to normal processTurn with synthetic input
          warmTransferInput = intent;
          transferredApp = targetApp;
        } else {
          // Cold transfer — deliver target app's greeting
          if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'transfer', speaker: 'system', content: `Transferred to ${targetApp.name}`, meta: { to_app: callAppOverride } }).catch((err: unknown) => console.error('CDR write failed:', err)));
          const greeting = await targetApp.onStart(context);
          if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'greeting', speaker: 'system', content: greeting.speech?.text ?? '' }).catch((err: unknown) => console.error('CDR write failed:', err)));
          await applyTTS(greeting, origin, env, 'greeting', targetApp.voice);
          const percl = await buildPerCL(greeting, request.url, getTTSProvider(env));
          return Response.json(percl, { headers: { 'Content-Type': 'application/json' } });
        }
      }
      // Target app not found — fall through to normal routing
    }

    // Route to app — warm transfer or KV override (post-transfer) takes precedence, then phone routes
    const app = transferredApp
      ?? (callAppOverride ? registry.get(callAppOverride) ?? registry.getForNumber(body.to) : registry.getForNumber(body.to));

    if (!app) {
      return Response.json([{ Hangup: {} }]);
    }

    const input: SpeechInput = {
      text: warmTransferInput ?? body.transcript ?? '',
      confidence: undefined,
    };

    // --- Engine: decide what happens this turn ---
    const streaming = (env.TTS_MODE === 'google' || env.TTS_MODE === '11labs') && !!ctx;
    const result: TurnResult = await processTurn(app, context, input, {
      streaming,
      preFillerProbability: PRE_FILLER_PROBABILITY,
    });

    // --- FreeClimb adapter: convert TurnResult to PerCL ---

    if (result.type === 'no-input') {
      console.log(JSON.stringify({ event: 'no_input', callId: body.callId, transcribeReason: body.transcribeReason, timestamp: new Date().toISOString() }));
      // CDR: record no-input turn
      if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'no_input', speaker: 'system', content: result.retryPhrase, meta: { transcribeReason: body.transcribeReason } }).catch((err: unknown) => console.error('CDR write failed:', err)));
      return handleNoInputResponse(result.retryPhrase, origin, env, app.voice);
    }

    if (result.type === 'stream') {
      // CDR: record caller speech
      if (db && body.transcript) {
        ctx!.waitUntil(addTurn(db, { callId: body.callId, turnType: 'caller_speech', speaker: 'caller', content: body.transcript }).catch((err: unknown) => console.error('CDR write failed:', err)));
      }

      // Per-turn UUID prevents stale KV reads
      const turnId = crypto.randomUUID();
      const callKey = `stream:${context.callId}:${turnId}`;

      // CDR callback: fired when streaming completes with all sentence texts
      const onStreamComplete = db
        ? async (sentences: string[], hangup: boolean) => {
            const fullText = sentences.join(' ');
            if (fullText) {
              await addTurn(db, { callId: body.callId, turnType: hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: fullText }).catch((err: unknown) => console.error('CDR write failed:', err));
            }
            if (hangup) await endCallRecord(db, body.callId, 'completed').catch((err: unknown) => console.error('CDR write failed:', err));
          }
        : undefined;

      try {
        if (result.preFiller) {
          // CDR: record filler turn
          if (db) ctx!.waitUntil(addTurn(db, { callId: body.callId, turnType: 'filler', speaker: 'system', content: result.preFiller.phrase }).catch((err: unknown) => console.error('CDR write failed:', err)));
          return await handlePreFillerStream(result, context, turnId, callKey, origin, env, ctx!, onStreamComplete, app.voice);
        }
        return await handleStandardStream(result, context, turnId, callKey, origin, env, ctx!, onStreamComplete, app.voice);
      } catch (streamErr) {
        console.error('Streaming path error, falling back to non-streaming:', streamErr);
        // Fall through to non-streaming below
      }

      // Streaming failed — fall back to non-streaming via onSpeech
      const fallback = await app.onSpeech(context, input);
      await applyTTS(fallback, origin, env, 'response', app.voice);
      const percl = await buildPerCL(fallback, request.url, getTTSProvider(env));
      if (fallback.hangup && result.cleanup && ctx) ctx.waitUntil(result.cleanup());
      // CDR: record fallback response
      if (db && fallback.speech?.text) {
        ctx?.waitUntil(
          addTurn(db, { callId: body.callId, turnType: fallback.hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: fallback.speech.text })
            .then(() => fallback.hangup ? endCallRecord(db, body.callId, 'completed') : undefined)
            .catch((err: unknown) => console.error('CDR write failed:', err)),
        );
      }
      return Response.json(percl, { headers: { 'Content-Type': 'application/json' } });
    }

    // type === 'response' — non-streaming path
    // Pre-generate TTS for direct modes (google, 11labs) so buildPerCL emits Play, not Say
    await applyTTS(result.speech, origin, env, 'response', app.voice);

    // CDR: record caller speech + response
    if (db) {
      const cdrWrites = async () => {
        if (body.transcript) await addTurn(db, { callId: body.callId, turnType: 'caller_speech', speaker: 'caller', content: body.transcript! }).catch((err: unknown) => console.error('CDR write failed:', err));
        if (result.speech.speech?.text) await addTurn(db, { callId: body.callId, turnType: result.speech.hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: result.speech.speech.text }).catch((err: unknown) => console.error('CDR write failed:', err));
        if (result.speech.hangup) await endCallRecord(db, body.callId, 'completed').catch((err: unknown) => console.error('CDR write failed:', err));
      };
      ctx?.waitUntil(cdrWrites());
    }

    const percl = await buildPerCL(result.speech, request.url, getTTSProvider(env));

    if (result.cleanup && ctx) {
      ctx.waitUntil(result.cleanup());
    }

    return Response.json(percl, {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in handleConversation:', error instanceof Error ? error.stack : String(error));
    return Response.json([
      { Say: { text: 'Sorry, an error occurred. Please try again.' } },
      { Hangup: {} },
    ], { status: 500 });
  }
}

// --- FreeClimb-specific delivery helpers ---

/** Handle no-input: play cached retry phrase + TranscribeUtterance. */
async function handleNoInputResponse(
  retryPhrase: string,
  origin: string,
  env: Env,
  voice?: string,
): Promise<Response> {
  // Use a stable cache key based on the phrase content for consistent TTS caching
  const phraseKey = retryPhrase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const retryCacheKey = `retry-${phraseKey}-${voiceSlug(env, voice)}`;
  let retryAudio = await env.RATE_LIMIT_KV.get(`tts:${retryCacheKey}`, 'arrayBuffer');
  if (!retryAudio) {
    retryAudio = await callTTS(retryPhrase, env, voice);
    await env.RATE_LIMIT_KV.put(`tts:${retryCacheKey}`, retryAudio, { expirationTtl: 6 * 60 * 60 });
  }
  return Response.json([
    { Play: { file: `${origin}/tts-cache?id=${retryCacheKey}` } },
    {
      TranscribeUtterance: {
        actionUrl: `${origin}/conversation`,
        playBeep: false,
        record: { maxLengthSec: 25, rcrdTerminationSilenceTimeMs: 3000 },
      },
    },
  ], { headers: { 'Content-Type': 'application/json' } });
}

/** Handle pre-filler streaming: play cached filler immediately, full stream in background. */
async function handlePreFillerStream(
  result: Extract<TurnResult, { type: 'stream' }>,
  context: AppContext,
  turnId: string,
  callKey: string,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
  onStreamComplete?: (sentences: string[], hangup: boolean) => Promise<void>,
  voice?: string,
): Promise<Response> {
  const { preFiller, stream, skipFillers, cleanup } = result;
  console.log(JSON.stringify({ event: 'pre_filler', callId: context.callId, turnId, timestamp: new Date().toISOString() }));
  const fillerId = `filler-${preFiller!.fillerIndex}-${voiceSlug(env, voice)}`;

  // Cache-first: filler audio is reused across calls
  let fillerAudio = await env.RATE_LIMIT_KV.get(`tts:${fillerId}`, 'arrayBuffer');
  if (!fillerAudio) {
    fillerAudio = await callTTS(preFiller!.phrase, env, voice);
    await env.RATE_LIMIT_KV.put(`tts:${fillerId}`, fillerAudio, { expirationTtl: 6 * 60 * 60 });
  }

  // Start the full stream in background — skipFillers prevents double-filler
  ctx.waitUntil(processRemainingStream(stream, callKey, env, 0, { skipFillers, onHangup: cleanup, onStreamComplete, voice }));

  return Response.json(
    [
      { Play: { file: `${origin}/tts-cache?id=${fillerId}` } },
      { Redirect: { actionUrl: `${origin}/continue?callId=${context.callId}&turn=${turnId}&n=0` } },
    ],
    { headers: { 'Content-Type': 'application/json' } },
  );
}

/** Handle standard streaming: await first sentence, TTS it, background the rest. */
async function handleStandardStream(
  result: Extract<TurnResult, { type: 'stream' }>,
  context: AppContext,
  turnId: string,
  callKey: string,
  origin: string,
  env: Env,
  ctx: ExecutionContext,
  onStreamComplete?: (sentences: string[], hangup: boolean) => Promise<void>,
  voice?: string,
): Promise<Response> {
  const { stream, cleanup } = result;
  const firstResult = await stream.next();

  if (!firstResult.done) {
    const chunk1 = firstResult.value;
    const safeSentence1 = sanitizeForTTS(chunk1.text);

    if (safeSentence1) {
      // If the chunk has a stable cache key (filler/goodbye phrase), use cache-first with long TTL.
      // Otherwise generate fresh audio with a UUID and short TTL.
      let s1Audio: ArrayBuffer;
      let s1Id: string;
      if (chunk1.cacheKey) {
        s1Id = `${chunk1.cacheKey}-${voiceSlug(env, voice)}`;
        const cached = await env.RATE_LIMIT_KV.get(`tts:${s1Id}`, 'arrayBuffer');
        if (cached) {
          s1Audio = cached;
        } else {
          s1Audio = await callTTS(safeSentence1, env, voice);
          await env.RATE_LIMIT_KV.put(`tts:${s1Id}`, s1Audio, { expirationTtl: 6 * 60 * 60 });
        }
      } else {
        s1Id = crypto.randomUUID();
        s1Audio = await callTTS(safeSentence1, env, voice);
        await env.RATE_LIMIT_KV.put(`tts:${s1Id}`, s1Audio, { expirationTtl: 120 });
      }

      if (chunk1.hangup) {
        // Generator signaled hangup — brief pause so goodbye doesn't cut off abruptly
        if (cleanup) ctx.waitUntil(cleanup());
        // CDR: record goodbye (single sentence, stream complete)
        if (onStreamComplete) ctx.waitUntil(onStreamComplete([safeSentence1], true).catch((err: unknown) => console.error('CDR write failed:', err)));
        return Response.json(
          [{ Play: { file: `${origin}/tts-cache?id=${s1Id}` } }, { Pause: { length: 300 } }, { Hangup: {} }],
          { headers: { 'Content-Type': 'application/json' } },
        );
      }

      // Queue remaining sentences in background and start redirect chain
      // The onStreamComplete callback receives remaining sentences; prepend the first sentence
      const wrappedOnComplete = onStreamComplete
        ? async (sentences: string[], hangup: boolean) => onStreamComplete([safeSentence1, ...sentences], hangup)
        : undefined;
      await env.RATE_LIMIT_KV.put(`${callKey}:1`, s1Id, { expirationTtl: 120 });
      ctx.waitUntil(processRemainingStream(stream, callKey, env, 1, { onHangup: cleanup, onStreamComplete: wrappedOnComplete, voice }));

      return Response.json(
        [
          { Play: { file: `${origin}/tts-cache?id=${s1Id}` } },
          { Redirect: { actionUrl: `${origin}/continue?callId=${context.callId}&turn=${turnId}&n=1` } },
        ],
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // Stream produced nothing — fall through handled by caller
  throw new Error('Stream produced no usable content');
}