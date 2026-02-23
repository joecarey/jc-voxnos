// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './core/registry.js';
import { EchoApp } from './apps/echo.js';
import { AvaAssistant } from './apps/ava.js';
import { OttoAssistant } from './apps/otto.js';
import type { Env } from './core/types.js';
import { validateEnv, getEnvSetupInstructions } from './core/env.js';
import { requireAdminAuth, createUnauthorizedResponse } from './core/auth.js';
import { validateWebhook, createWebhookUnauthorizedResponse } from './core/webhook-auth.js';
import { toolRegistry } from './tools/registry.js';
import { WeatherTool } from './tools/weather.js';
import { CognosTool } from './tools/cognos.js';
import { checkRateLimit, getIPFromRequest, RATE_LIMITS } from './core/rate-limit.js';
import {
  handleIncomingCall,
  handleConversation,
  handleHealthCheck,
  handleListApps,
  handleDebugAccount,
  handleListPhoneNumbers,
  handleSetup,
  handleUpdatePhoneNumber,
  handleGetLogs,
  handleUpdateApplication,
} from './routes.js';
import { callElevenLabs, callGoogleTTS, computeTtsSignature } from './tts/index.js';

// Deferred setup — runs once per isolate on first request so env is available.
let setupDone = false;
function setup(env: Env): void {
  if (setupDone) return;
  toolRegistry.register(new WeatherTool());
  toolRegistry.register(new CognosTool(env.COGNOS_PUBLIC_KEY, env.COGNOS));
  registry.register(new EchoApp());
  registry.register(new OttoAssistant());
  registry.register(new AvaAssistant(), true);
  setupDone = true;
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const auth = requireAdminAuth(request, env);
  if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

  const authHeader = request.headers.get('Authorization');
  const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
  const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
  if (!rateLimit.allowed) return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });

  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Validate environment configuration
    const envValidation = validateEnv(env);
    if (!envValidation.valid) {
      console.error('Environment validation failed:', envValidation);
      return new Response(getEnvSetupInstructions(envValidation), {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    setup(env);

    const url = new URL(request.url);

    // FreeClimb call webhook - handles incoming calls
    if (url.pathname === '/call' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_SIGNING_SECRET);
      if (!webhookAuth.valid) {
        return createWebhookUnauthorizedResponse(webhookAuth.error!);
      }

      // Rate limit by IP to prevent flood attacks
      const ip = getIPFromRequest(request);
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `call:${ip}`, RATE_LIMITS.CALL_START);

      if (!rateLimit.allowed) {
        return new Response('Too many call attempts', { status: 429 });
      }

      return handleIncomingCall(request, env, ctx);
    }

    // FreeClimb conversation webhook - handles each turn of dialogue
    if (url.pathname === '/conversation' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_SIGNING_SECRET);
      if (!webhookAuth.valid) {
        return createWebhookUnauthorizedResponse(webhookAuth.error!);
      }

      // Rate limit by callId to prevent runaway loops
      const body = await request.json() as any;
      const callId = body.callId || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, callId, RATE_LIMITS.CONVERSATION);

      if (!rateLimit.allowed) {
        console.warn(`Rate limit exceeded for call ${callId}`);
        return Response.json({
          error: 'Too many requests, please slow down'
        }, { status: 429 });
      }

      return handleConversation(request, env, ctx, body);
    }

    // Health check
    if (url.pathname === '/') {
      return handleHealthCheck();
    }

    // List registered apps
    if (url.pathname === '/apps') {
      return handleListApps();
    }

    // Debug FreeClimb account
    if (url.pathname === '/debug/account' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleDebugAccount(env);
    }

    // List FreeClimb phone numbers
    if (url.pathname === '/phone-numbers' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleListPhoneNumbers(env);
    }

    // Setup FreeClimb application and phone number
    if (url.pathname === '/setup' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleSetup(request, env);
    }

    // Update phone number alias
    if (url.pathname === '/update-number' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleUpdatePhoneNumber(request, env);
    }

    // Get FreeClimb logs
    if (url.pathname === '/logs' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleGetLogs(request, env);
    }

    // Update FreeClimb application URLs
    if (url.pathname === '/update-app' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleUpdateApplication(request, env);
    }

    // Cost tracking summary
    if (url.pathname === '/costs' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;

      const days: Array<{ date: string; input_tokens: number; output_tokens: number; requests: number }> = [];
      for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - i);
        const date = d.toISOString().split('T')[0];
        const val = await env.RATE_LIMIT_KV.get(`costs:voxnos:${date}`, 'json') as { input_tokens: number; output_tokens: number; requests: number } | null;
        days.push({ date, input_tokens: val?.input_tokens ?? 0, output_tokens: val?.output_tokens ?? 0, requests: val?.requests ?? 0 });
      }
      return Response.json({ service: 'voxnos', days });
    }

    // On-demand TTS endpoint — called by FreeClimb Play command (TTS_MODE=google|11labs)
    // URL is HMAC-signed by our Worker; random callers cannot forge a valid signature
    if (url.pathname === '/tts' && request.method === 'GET') {
      const text = url.searchParams.get('text');
      const voiceId = url.searchParams.get('voice');
      const sig = url.searchParams.get('sig');

      if (!text || !sig) {
        return new Response('Bad request', { status: 400 });
      }

      const decodedText = decodeURIComponent(text);
      const expectedSig = await computeTtsSignature(decodedText, env.TTS_SIGNING_SECRET);

      if (sig !== expectedSig) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        let audioBuffer: ArrayBuffer;
        let contentType: string;
        if (env.TTS_MODE === 'google') {
          audioBuffer = await callGoogleTTS(decodedText, env.GOOGLE_TTS_API_KEY!);
          contentType = 'audio/wav';
        } else {
          audioBuffer = await callElevenLabs(decodedText, env.ELEVENLABS_API_KEY!, voiceId ?? undefined, env.ELEVENLABS_BASE_URL);
          contentType = 'audio/mpeg';
        }
        return new Response(audioBuffer, {
          headers: { 'Content-Type': contentType },
        });
      } catch (err) {
        console.error('TTS error:', err);
        return new Response('TTS generation failed', { status: 502 });
      }
    }

    // Pre-generated TTS audio cache — served by UUID (V2 streaming path)
    // UUID is unguessable (128-bit random), no additional signing needed
    if (url.pathname === '/tts-cache' && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Bad request', { status: 400 });

      const audio = await env.RATE_LIMIT_KV.get(`tts:${id}`, 'arrayBuffer');
      if (!audio) return new Response('Not found', { status: 404 });

      // Detect format from magic bytes: WAV starts with "RIFF" (0x52 0x49 0x46 0x46)
      const magic = new Uint8Array(audio, 0, 4);
      const isWav = magic[0] === 0x52 && magic[1] === 0x49 && magic[2] === 0x46 && magic[3] === 0x46;
      const headers = {
        'Content-Type': isWav ? 'audio/wav' : 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };

      return new Response(request.method === 'HEAD' ? null : audio, { headers });
    }

    // V2 redirect chain — called by FreeClimb after playing sentence N, retrieves sentence N+1
    // callId is a FreeClimb-generated ID; unguessable in practice
    // FreeClimb's Redirect command sends POST; also accept GET for flexibility
    if (url.pathname === '/continue' && (request.method === 'GET' || request.method === 'POST')) {
      const callId = url.searchParams.get('callId');
      const turnId = url.searchParams.get('turn');
      const n = parseInt(url.searchParams.get('n') ?? '0', 10);

      if (!callId) return new Response('Bad request', { status: 400 });

      // turnId namespaces each conversation turn; prevents stale reads from prior turns
      const callKey = turnId ? `stream:${callId}:${turnId}` : `stream:${callId}`;
      const nextN = n + 1;
      const origin = new URL(request.url).origin;

      // Poll for background TTS to finish. Use short intervals to minimise
      // dead air but stay well under FreeClimb's webhook response timeout (~15s).
      // 15 × 500ms = 7.5s max; Cognos briefs take ~3-8s so this is usually enough.
      const pollStart = Date.now();
      let nextId: string | null = null;
      let pollAttempts = 0;
      for (let attempt = 0; attempt < 15; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        pollAttempts = attempt + 1;
        nextId = await env.RATE_LIMIT_KV.get(`${callKey}:${nextN}`);
        if (nextId) break;
        const done = await env.RATE_LIMIT_KV.get(`${callKey}:done`);
        if (done) break;
      }
      console.log(JSON.stringify({ event: 'continue_poll', callId, n, nextN, found: !!nextId, attempts: pollAttempts, elapsed_ms: Date.now() - pollStart }));

      const transcribeUtterance = {
        TranscribeUtterance: {
          actionUrl: `${origin}/conversation`,
          playBeep: false,
          record: { maxLengthSec: 25, rcrdTerminationSilenceTimeMs: 3000 },
        },
      };

      if (!nextId) {
        // No more sentences — prompt caller for next input
        return Response.json([transcribeUtterance]);
      }

      // Check if processRemainingStream flagged this sentence as a hangup
      const hangupAt = await env.RATE_LIMIT_KV.get(`${callKey}:hangup`);
      if (hangupAt === String(nextN)) {
        return Response.json([
          { Play: { file: `${origin}/tts-cache?id=${nextId}` } },
          { Pause: { length: 300 } },
          { Hangup: {} },
        ]);
      }

      const turnParam = turnId ? `&turn=${turnId}` : '';
      return Response.json([
        { Play: { file: `${origin}/tts-cache?id=${nextId}` } },
        { Redirect: { actionUrl: `${origin}/continue?callId=${callId}${turnParam}&n=${nextN}` } },
      ]);
    }

    return new Response('Not Found', { status: 404 });
  },
};
