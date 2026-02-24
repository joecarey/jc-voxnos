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

function freeclimbAuth(env: Env): { auth: string; apiBase: string } {
  return {
    auth: btoa(`${env.FREECLIMB_ACCOUNT_ID}:${env.FREECLIMB_API_KEY}`),
    apiBase: 'https://www.freeclimb.com/apiserver',
  };
}

/** Pre-generate greeting audio for direct TTS modes and set audioUrls on the response. */
async function applyGreetingTTS(response: AppResponse, origin: string, env: Env): Promise<void> {
  if ((env.TTS_MODE === 'google' || env.TTS_MODE === '11labs') && response.speech?.text) {
    const safeText = sanitizeForTTS(response.speech.text);
    if (safeText) {
      const gId = greetingCacheKey(safeText, voiceSlug(env));
      try {
        let audio = await env.RATE_LIMIT_KV.get(`tts:${gId}`, 'arrayBuffer');
        if (audio) {
          console.log(JSON.stringify({ event: 'greeting_cache_hit', key: gId, timestamp: new Date().toISOString() }));
        } else {
          audio = await callTTS(safeText, env);
          await env.RATE_LIMIT_KV.put(`tts:${gId}`, audio, { expirationTtl: 6 * 60 * 60 });
          console.log(JSON.stringify({ event: 'greeting_cache_miss', key: gId, timestamp: new Date().toISOString() }));
        }
        response.audioUrls = [`${origin}/tts-cache?id=${gId}`];
      } catch (ttsErr) {
        console.error(JSON.stringify({ event: 'greeting_tts_fail', error: String(ttsErr), timestamp: new Date().toISOString() }));
      }
    }
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
          .catch(() => {}),
      );
    }

    // Pre-generate greeting audio for direct TTS modes (google, 11labs).
    // Falls through to FreeClimb Say if TTS fails.
    const origin = new URL(request.url).origin;
    await applyGreetingTTS(response, origin, env);

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
      if (db) ctx?.waitUntil(endCallRecord(db, body.callId, 'completed').catch(() => {}));
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
                .catch(() => {}),
            );
          }
          // Fall through to normal processTurn with synthetic input
          warmTransferInput = intent;
          transferredApp = targetApp;
        } else {
          // Cold transfer — deliver target app's greeting
          if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'transfer', speaker: 'system', content: `Transferred to ${targetApp.name}`, meta: { to_app: callAppOverride } }).catch(() => {}));
          const greeting = await targetApp.onStart(context);
          if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'greeting', speaker: 'system', content: greeting.speech?.text ?? '' }).catch(() => {}));
          await applyGreetingTTS(greeting, origin, env);
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
      if (db) ctx?.waitUntil(addTurn(db, { callId: body.callId, turnType: 'no_input', speaker: 'system', content: result.retryPhrase, meta: { transcribeReason: body.transcribeReason } }).catch(() => {}));
      return handleNoInputResponse(result.retryPhrase, origin, env);
    }

    if (result.type === 'stream') {
      // CDR: record caller speech
      if (db && body.transcript) {
        ctx!.waitUntil(addTurn(db, { callId: body.callId, turnType: 'caller_speech', speaker: 'caller', content: body.transcript }).catch(() => {}));
      }

      // Per-turn UUID prevents stale KV reads
      const turnId = crypto.randomUUID();
      const callKey = `stream:${context.callId}:${turnId}`;

      // CDR callback: fired when streaming completes with all sentence texts
      const onStreamComplete = db
        ? async (sentences: string[], hangup: boolean) => {
            const fullText = sentences.join(' ');
            if (fullText) {
              await addTurn(db, { callId: body.callId, turnType: hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: fullText }).catch(() => {});
            }
            if (hangup) await endCallRecord(db, body.callId, 'completed').catch(() => {});
          }
        : undefined;

      try {
        if (result.preFiller) {
          // CDR: record filler turn
          if (db) ctx!.waitUntil(addTurn(db, { callId: body.callId, turnType: 'filler', speaker: 'system', content: result.preFiller.phrase }).catch(() => {}));
          return await handlePreFillerStream(result, context, turnId, callKey, origin, env, ctx!, onStreamComplete);
        }
        return await handleStandardStream(result, context, turnId, callKey, origin, env, ctx!, onStreamComplete);
      } catch (streamErr) {
        console.error('Streaming path error, falling back to non-streaming:', streamErr);
        // Fall through to non-streaming below
      }

      // Streaming failed — fall back to non-streaming via onSpeech
      const fallback = await app.onSpeech(context, input);
      const percl = await buildPerCL(fallback, request.url, getTTSProvider(env));
      if (fallback.hangup && result.cleanup && ctx) ctx.waitUntil(result.cleanup());
      // CDR: record fallback response
      if (db && fallback.speech?.text) {
        ctx?.waitUntil(
          addTurn(db, { callId: body.callId, turnType: fallback.hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: fallback.speech.text })
            .then(() => fallback.hangup ? endCallRecord(db, body.callId, 'completed') : undefined)
            .catch(() => {}),
        );
      }
      return Response.json(percl, { headers: { 'Content-Type': 'application/json' } });
    }

    // type === 'response' — non-streaming path
    // CDR: record caller speech + response
    if (db) {
      const cdrWrites = async () => {
        if (body.transcript) await addTurn(db, { callId: body.callId, turnType: 'caller_speech', speaker: 'caller', content: body.transcript! }).catch(() => {});
        if (result.speech.speech?.text) await addTurn(db, { callId: body.callId, turnType: result.speech.hangup ? 'goodbye' : 'assistant_response', speaker: 'system', content: result.speech.speech.text }).catch(() => {});
        if (result.speech.hangup) await endCallRecord(db, body.callId, 'completed').catch(() => {});
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
): Promise<Response> {
  // Use a stable cache key based on the phrase content for consistent TTS caching
  const phraseKey = retryPhrase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const retryCacheKey = `retry-${phraseKey}-${voiceSlug(env)}`;
  let retryAudio = await env.RATE_LIMIT_KV.get(`tts:${retryCacheKey}`, 'arrayBuffer');
  if (!retryAudio) {
    retryAudio = await callTTS(retryPhrase, env);
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
): Promise<Response> {
  const { preFiller, stream, skipFillers, cleanup } = result;
  console.log(JSON.stringify({ event: 'pre_filler', callId: context.callId, turnId, timestamp: new Date().toISOString() }));
  const fillerId = `filler-${preFiller!.fillerIndex}-${voiceSlug(env)}`;

  // Cache-first: filler audio is reused across calls
  let fillerAudio = await env.RATE_LIMIT_KV.get(`tts:${fillerId}`, 'arrayBuffer');
  if (!fillerAudio) {
    fillerAudio = await callTTS(preFiller!.phrase, env);
    await env.RATE_LIMIT_KV.put(`tts:${fillerId}`, fillerAudio, { expirationTtl: 6 * 60 * 60 });
  }

  // Start the full stream in background — skipFillers prevents double-filler
  ctx.waitUntil(processRemainingStream(stream, callKey, env, 0, { skipFillers, onHangup: cleanup, onStreamComplete }));

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
        s1Id = `${chunk1.cacheKey}-${voiceSlug(env)}`;
        const cached = await env.RATE_LIMIT_KV.get(`tts:${s1Id}`, 'arrayBuffer');
        if (cached) {
          s1Audio = cached;
        } else {
          s1Audio = await callTTS(safeSentence1, env);
          await env.RATE_LIMIT_KV.put(`tts:${s1Id}`, s1Audio, { expirationTtl: 6 * 60 * 60 });
        }
      } else {
        s1Id = crypto.randomUUID();
        s1Audio = await callTTS(safeSentence1, env);
        await env.RATE_LIMIT_KV.put(`tts:${s1Id}`, s1Audio, { expirationTtl: 120 });
      }

      if (chunk1.hangup) {
        // Generator signaled hangup — brief pause so goodbye doesn't cut off abruptly
        if (cleanup) ctx.waitUntil(cleanup());
        // CDR: record goodbye (single sentence, stream complete)
        if (onStreamComplete) ctx.waitUntil(onStreamComplete([safeSentence1], true).catch(() => {}));
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
      ctx.waitUntil(processRemainingStream(stream, callKey, env, 1, { onHangup: cleanup, onStreamComplete: wrappedOnComplete }));

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

/**
 * Health check endpoint
 */
export function handleHealthCheck(): Response {
  return new Response('voxnos platform running', { status: 200 });
}

/**
 * List registered apps endpoint
 */
export function handleListApps(): Response {
  const apps = registry.list().map(app => ({
    id: app.id,
    name: app.name,
  }));
  return Response.json(apps);
}

/**
 * Debug FreeClimb account endpoint
 */
export async function handleDebugAccount(env: Env): Promise<Response> {
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Try different API paths
    const tests = [
      { name: 'Account', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}` },
      { name: 'IncomingPhoneNumbers (with account)', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers` },
      { name: 'Applications (with account)', url: `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications` },
      { name: 'IncomingPhoneNumbers (no account)', url: `${apiBase}/IncomingPhoneNumbers` },
      { name: 'Applications (no account)', url: `${apiBase}/Applications` },
      { name: 'Calls', url: `${apiBase}/Calls` },
    ];

    const results = [];

    for (const test of tests) {
      const response = await fetch(test.url, {
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });

      const data = await response.text();
      results.push({
        endpoint: test.name,
        status: response.status,
        response: data.substring(0, 200), // First 200 chars
      });
    }

    return Response.json({
      accountId: env.FREECLIMB_ACCOUNT_ID.substring(0, 8) + '...',
      results,
    });

  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

/**
 * List FreeClimb phone numbers endpoint
 */
export async function handleListPhoneNumbers(env: Env): Promise<Response> {
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    const response = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({ error: 'Failed to fetch phone numbers', details: error }, { status: 500 });
    }

    const data = await response.json() as {
      incomingPhoneNumbers: Array<{
        phoneNumberId: string;
        phoneNumber: string;
        alias: string;
        voiceUrl?: string;
        applicationId?: string;
      }>;
    };

    const phoneNumbers = data.incomingPhoneNumbers || [];

    return Response.json({
      count: phoneNumbers.length,
      phoneNumbers: phoneNumbers.map(n => ({
        id: n.phoneNumberId,
        number: n.phoneNumber,
        alias: n.alias,
        voiceUrl: n.voiceUrl,
        applicationId: n.applicationId,
      })),
    });

  } catch (error) {
    console.error('Error fetching phone numbers:', error);
    return Response.json({ error: 'Failed to fetch phone numbers', details: String(error) }, { status: 500 });
  }
}

/**
 * Setup FreeClimb application and phone number endpoint
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phoneNumber?: string };
  const baseUrl = new URL(request.url).origin;

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Step 1: Create FreeClimb Application
    console.log('Creating FreeClimb application...');
    const appResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        alias: 'Voxnos Platform',
        voiceUrl: `${baseUrl}/call`,
        voiceFallbackUrl: `${baseUrl}/call`,
      }),
    });

    if (!appResponse.ok) {
      const error = await appResponse.text();
      return Response.json({ error: 'Failed to create application', details: error }, { status: 500 });
    }

    const application = await appResponse.json() as { applicationId: string };
    console.log('Application created:', application.applicationId);

    // Step 2: Get phone numbers
    console.log('Fetching phone numbers...');
    const numbersResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!numbersResponse.ok) {
      const error = await numbersResponse.text();
      return Response.json({ error: 'Failed to fetch phone numbers', details: error }, { status: 500 });
    }

    const numbersData = await numbersResponse.json() as {
      incomingPhoneNumbers: Array<{
        phoneNumberId: string;
        phoneNumber: string;
        alias: string;
      }>;
    };

    const phoneNumbers = numbersData.incomingPhoneNumbers || [];

    if (phoneNumbers.length === 0) {
      return Response.json({
        error: 'No phone numbers found',
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/call` },
      });
    }

    // Step 3: Update phone number to use the application
    const targetNumber = body.phoneNumber
      ? phoneNumbers.find(n => n.phoneNumber === body.phoneNumber)
      : phoneNumbers[0]; // Use first number if none specified

    if (!targetNumber) {
      return Response.json({
        error: 'Phone number not found',
        available: phoneNumbers.map(n => n.phoneNumber),
        application: { id: application.applicationId, voiceUrl: `${baseUrl}/call` },
      });
    }

    console.log(`Configuring phone number ${targetNumber.phoneNumber}...`);
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers/${targetNumber.phoneNumberId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          applicationId: application.applicationId,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update phone number', details: error }, { status: 500 });
    }

    return Response.json({
      success: true,
      application: {
        id: application.applicationId,
        name: 'Voxnos Platform',
        voiceUrl: `${baseUrl}/call`,
      },
      phoneNumber: {
        id: targetNumber.phoneNumberId,
        number: targetNumber.phoneNumber,
        configured: true,
      },
      message: `Call ${targetNumber.phoneNumber} to test the Claude assistant!`,
    });

  } catch (error) {
    console.error('Setup error:', error);
    return Response.json({ error: 'Setup failed', details: String(error) }, { status: 500 });
  }
}

/**
 * Update phone number alias endpoint
 */
export async function handleUpdatePhoneNumber(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { phoneNumberId: string; alias?: string };

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/IncomingPhoneNumbers/${body.phoneNumberId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          alias: body.alias,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update phone number', details: error }, { status: 500 });
    }

    const updated = await updateResponse.json();

    return Response.json({
      success: true,
      phoneNumber: updated,
    });

  } catch (error) {
    console.error('Update error:', error);
    return Response.json({ error: 'Update failed', details: String(error) }, { status: 500 });
  }
}

/**
 * Get FreeClimb logs endpoint
 */
export async function handleGetLogs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get('callId');

  const { auth, apiBase } = freeclimbAuth(env);

  try {
    let logsUrl: string;

    if (callId) {
      // Get logs for specific call
      logsUrl = `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Calls/${callId}/Logs`;
    } else {
      // Get recent logs (last 50)
      logsUrl = `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Logs`;
    }

    const response = await fetch(logsUrl, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return Response.json({
        error: 'Failed to fetch logs',
        details: error,
        url: logsUrl
      }, { status: response.status });
    }

    const logs = await response.json();

    return Response.json(logs);

  } catch (error) {
    console.error('Error fetching logs:', error);
    return Response.json({ error: 'Failed to fetch logs', details: String(error) }, { status: 500 });
  }
}

/**
 * Update FreeClimb application URLs endpoint
 */
export async function handleUpdateApplication(request: Request, env: Env): Promise<Response> {
  const baseUrl = new URL(request.url).origin;
  const { auth, apiBase } = freeclimbAuth(env);

  try {
    // Step 1: List all applications to find the Voxnos one
    console.log('Fetching applications...');
    const appsResponse = await fetch(`${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications`, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (!appsResponse.ok) {
      const error = await appsResponse.text();
      return Response.json({ error: 'Failed to fetch applications', details: error }, { status: 500 });
    }

    const appsData = await appsResponse.json() as {
      applications: Array<{
        applicationId: string;
        alias: string;
        voiceUrl: string;
        voiceFallbackUrl?: string;
      }>;
    };

    const apps = appsData.applications || [];
    const voxnosApp = apps.find(app => app.alias === 'Voxnos Platform');

    if (!voxnosApp) {
      return Response.json({
        error: 'Voxnos Platform application not found',
        availableApps: apps.map(a => ({ id: a.applicationId, name: a.alias })),
      });
    }

    console.log(`Found Voxnos app: ${voxnosApp.applicationId}, current voiceUrl: ${voxnosApp.voiceUrl}`);

    // Step 2: Update the application's voiceUrl
    const newVoiceUrl = `${baseUrl}/call`;

    if (voxnosApp.voiceUrl === newVoiceUrl) {
      return Response.json({
        message: 'Application already configured correctly',
        application: {
          id: voxnosApp.applicationId,
          voiceUrl: voxnosApp.voiceUrl,
        },
      });
    }

    console.log(`Updating voiceUrl to: ${newVoiceUrl}`);
    const updateResponse = await fetch(
      `${apiBase}/Accounts/${env.FREECLIMB_ACCOUNT_ID}/Applications/${voxnosApp.applicationId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          voiceUrl: newVoiceUrl,
          voiceFallbackUrl: newVoiceUrl,
        }),
      }
    );

    if (!updateResponse.ok) {
      const error = await updateResponse.text();
      return Response.json({ error: 'Failed to update application', details: error }, { status: 500 });
    }

    const updated = await updateResponse.json();

    return Response.json({
      success: true,
      message: 'Application updated successfully',
      before: {
        voiceUrl: voxnosApp.voiceUrl,
      },
      after: {
        voiceUrl: newVoiceUrl,
      },
      application: updated,
    });

  } catch (error) {
    console.error('Update application error:', error);
    return Response.json({ error: 'Update failed', details: String(error) }, { status: 500 });
  }
}
