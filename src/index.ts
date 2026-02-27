// Voxnos - Platform for building speech-enabled voice applications
// Entry point: env validation, isolate setup, HTTP routing table.

import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp';
import { createServer } from './mcp-server.js';
import authHandler from './auth-handler.js';
import { registry } from './engine/registry.js';
import { EchoApp } from './apps/echo.js';
import { AvaAssistant } from './apps/ava.js';
import { RitaAssistant } from './apps/rita.js';
import type { Env } from './engine/types.js';
import { validateEnv, getEnvSetupInstructions } from './platform/env.js';
import { validateWebhook, createWebhookUnauthorizedResponse } from './platform/webhook-auth.js';
import { toolRegistry } from './tools/registry.js';
import { WeatherTool } from './tools/weather.js';
import { CognosTool } from './tools/cognos.js';
import { TransferTool } from './tools/transfer.js';
import { checkRateLimit, getIPFromRequest, RATE_LIMITS } from './platform/rate-limit.js';
import { handleIncomingCall, handleConversation } from './telephony/routes.js';
import {
  handleHealthCheck, handleListApps, handleDebugAccount,
  handleListPhoneNumbers, handleSetup, handleUpdatePhoneNumber,
  handleGetLogs, handleUpdateApplication,
  handleAvailableNumbers, handleBuyNumber,
} from './telephony/freeclimb-admin.js';
import { requireAdmin, requireD1 } from './admin/helpers.js';
import {
  registerAppFromDefinition,
  handleCosts, handleGetSurveyResult, handleListSurveyResults,
  handleGetCdr, handleListCdr,
  handleGetAppDefinition, handleDeleteAppDefinition, handleListAppDefinitions, handleCreateAppDefinition,
  handleListPhoneRoutes, handleCreatePhoneRoute, handleDeletePhoneRoute,
  handleReloadApps,
} from './admin/routes.js';
import { loadAllActiveApps, loadPhoneRoutes } from './services/app-store.js';
import { reloadAllowedCallers, isCallerAllowed } from './services/caller-allowlist.js';
import { callElevenLabs, callGoogleTTS, computeTtsSignature } from './tts/index.js';

// Deferred setup — runs once per isolate on first request so env is available.
let setupDone = false;
async function setup(env: Env): Promise<void> {
  if (setupDone) return;

  // Register tools
  toolRegistry.register(new WeatherTool());
  toolRegistry.register(new CognosTool(env.COGNOS_PUBLIC_KEY, env.COGNOS));
  toolRegistry.register(new TransferTool());

  // Register code-defined apps (not config-driven)
  registry.register(new EchoApp());

  // Load all app definitions from D1 (conversational + survey)
  if (env.DB) {
    try {
      const defs = await loadAllActiveApps(env.DB);
      for (const def of defs) {
        registerAppFromDefinition(def);
      }
      const routes = await loadPhoneRoutes(env.DB);
      for (const route of routes) {
        registry.setPhoneRoute(route.phone_number, route.app_id);
      }
      await reloadAllowedCallers(env.DB);
      if (defs.length) {
        console.log(JSON.stringify({ event: 'apps_loaded', count: defs.length, ids: defs.map(d => d.id) }));
      }
    } catch (err) {
      console.error('Failed to load app definitions from D1, falling back to static:', err);
      registry.register(new AvaAssistant(), { isDefault: true });
      registry.register(new RitaAssistant());
    }
  } else {
    registry.register(new AvaAssistant(), { isDefault: true });
    registry.register(new RitaAssistant());
  }

  setupDone = true;
}

/** Exported for use by auth-handler.ts as the default handler fallback. */
export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const envValidation = validateEnv(env);
    if (!envValidation.valid) {
      console.error('Environment validation failed:', envValidation);
      return new Response(getEnvSetupInstructions(envValidation), {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    await setup(env);

    const url = new URL(request.url);

    // --- FreeClimb webhooks (signature-validated) ---

    if (url.pathname === '/call' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_SIGNING_SECRET);
      if (!webhookAuth.valid) return createWebhookUnauthorizedResponse(webhookAuth.error!);
      const ip = getIPFromRequest(request);
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `call:${ip}`, RATE_LIMITS.CALL_START);
      if (!rateLimit.allowed) return new Response('Too many call attempts', { status: 429 });

      // Per-number caller allowlist — peek at body for from/to, reject if not allowed
      const bodyClone = await request.clone().json() as { from?: string; to?: string; callId?: string };
      if (bodyClone.from && bodyClone.to && !isCallerAllowed(bodyClone.to, bodyClone.from)) {
        console.log(JSON.stringify({ event: 'call_blocked', from: bodyClone.from, to: bodyClone.to, callId: bodyClone.callId, timestamp: new Date().toISOString() }));
        return Response.json([{ Reject: {} }]);
      }

      return handleIncomingCall(request, env, ctx);
    }

    if (url.pathname === '/conversation' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_SIGNING_SECRET);
      if (!webhookAuth.valid) return createWebhookUnauthorizedResponse(webhookAuth.error!);
      const body = await request.json() as any;
      const callId = body.callId || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, callId, RATE_LIMITS.CONVERSATION);
      if (!rateLimit.allowed) {
        console.warn(`Rate limit exceeded for call ${callId}`);
        return Response.json({ error: 'Too many requests, please slow down' }, { status: 429 });
      }
      return handleConversation(request, env, ctx, body);
    }

    // --- Public endpoints ---

    if (url.pathname === '/') return handleHealthCheck();
    if (url.pathname === '/apps') return handleListApps();

    // --- TTS endpoints (HMAC-signed or UUID-keyed) ---

    if (url.pathname === '/tts' && request.method === 'GET') {
      const text = url.searchParams.get('text');
      const voiceId = url.searchParams.get('voice');
      const sig = url.searchParams.get('sig');
      if (!text || !sig) return new Response('Bad request', { status: 400 });

      const decodedText = decodeURIComponent(text);
      const expectedSig = await computeTtsSignature(decodedText, env.TTS_SIGNING_SECRET);
      if (sig !== expectedSig) return new Response('Unauthorized', { status: 401 });

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
        return new Response(audioBuffer, { headers: { 'Content-Type': contentType } });
      } catch (err) {
        console.error('TTS error:', err);
        return new Response('TTS generation failed', { status: 502 });
      }
    }

    if (url.pathname === '/tts-cache' && (request.method === 'GET' || request.method === 'HEAD')) {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Bad request', { status: 400 });
      const audio = await env.RATE_LIMIT_KV.get(`tts:${id}`, 'arrayBuffer');
      if (!audio) return new Response('Not found', { status: 404 });
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

    // --- Streaming continue chain ---

    if (url.pathname === '/continue' && (request.method === 'GET' || request.method === 'POST')) {
      const callId = url.searchParams.get('callId');
      const turnId = url.searchParams.get('turn');
      const n = parseInt(url.searchParams.get('n') ?? '0', 10);
      if (!callId) return new Response('Bad request', { status: 400 });

      const callKey = turnId ? `stream:${callId}:${turnId}` : `stream:${callId}`;
      const nextN = n + 1;
      const origin = new URL(request.url).origin;

      const pollStart = Date.now();
      let nextId: string | null = null;
      let pollAttempts = 0;
      for (let attempt = 0; attempt < 25; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        pollAttempts = attempt + 1;
        nextId = await env.RATE_LIMIT_KV.get(`${callKey}:${nextN}`);
        if (nextId) break;
        const done = await env.RATE_LIMIT_KV.get(`${callKey}:done`);
        if (done) break;
        if (attempt > 0) {
          const pending = await env.RATE_LIMIT_KV.get(`${callKey}:pending`);
          if (!pending) break;
        }
      }
      console.log(JSON.stringify({ event: 'continue_poll', callId, n, nextN, found: !!nextId, attempts: pollAttempts, elapsed_ms: Date.now() - pollStart }));

      const transcribeUtterance = {
        TranscribeUtterance: {
          actionUrl: `${origin}/conversation`,
          playBeep: false,
          record: { maxLengthSec: 25, rcrdTerminationSilenceTimeMs: 3000 },
        },
      };

      if (!nextId) return Response.json([transcribeUtterance]);

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

    // --- Admin endpoints (Bearer: ADMIN_API_KEY) ---

    if (url.pathname === '/debug/account' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleDebugAccount(env);
    }

    if (url.pathname === '/phone-numbers' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleListPhoneNumbers(env);
    }

    if (url.pathname === '/available-numbers' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleAvailableNumbers(request, env);
    }

    if (url.pathname === '/buy-number' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleBuyNumber(request, env);
    }

    if (url.pathname === '/setup' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleSetup(request, env);
    }

    if (url.pathname === '/update-number' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleUpdatePhoneNumber(request, env);
    }

    if (url.pathname === '/logs' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleGetLogs(request, env);
    }

    if (url.pathname === '/update-app' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleUpdateApplication(request, env);
    }

    if (url.pathname === '/costs' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      return handleCosts(env);
    }

    // --- Admin + D1 endpoints ---

    if (url.pathname.startsWith('/survey-results/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleGetSurveyResult(url, env.DB!);
    }

    if (url.pathname === '/survey-results' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleListSurveyResults(url, env.DB!);
    }

    if (url.pathname.startsWith('/cdr/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleGetCdr(url, env.DB!);
    }

    if (url.pathname === '/cdr' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleListCdr(url, env.DB!);
    }

    if (url.pathname.startsWith('/apps/definitions/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleGetAppDefinition(url, env.DB!);
    }

    if (url.pathname.startsWith('/apps/definitions/') && request.method === 'DELETE') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleDeleteAppDefinition(url, env.DB!);
    }

    if (url.pathname === '/apps/definitions' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleListAppDefinitions(env.DB!);
    }

    if (url.pathname === '/apps/definitions' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleCreateAppDefinition(request, env.DB!);
    }

    if (url.pathname === '/phone-routes' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleListPhoneRoutes(env.DB!);
    }

    if (url.pathname === '/phone-routes' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleCreatePhoneRoute(request, env.DB!);
    }

    if (url.pathname.startsWith('/phone-routes/') && request.method === 'DELETE') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleDeletePhoneRoute(url, env.DB!);
    }

    if (url.pathname === '/reload-apps' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      const noDb = requireD1(env);
      if (noDb) return noDb;
      return handleReloadApps(env.DB!);
    }

    return new Response('Not Found', { status: 404 });
}

const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: {
    async fetch(request, env, ctx) {
      const server = createServer(env as Env);
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    },
  },
  defaultHandler: authHandler as ExportedHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  async resolveExternalToken({ token, env }) {
    if (token === (env as Env).MCP_API_KEY) {
      return { props: { user: 'claude-code', role: 'owner' } };
    }
    return null;
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },
};
