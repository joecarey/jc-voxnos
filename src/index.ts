// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './core/registry.js';
import { EchoApp } from './apps/echo.js';
import { ClaudeAssistant } from './apps/claude-assistant.js';
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
import { callElevenLabs, computeTtsSignature } from './tts/index.js';

// Register tools
toolRegistry.register(new WeatherTool());
toolRegistry.register(new CognosTool());

// Register apps
registry.register(new EchoApp());                // Simple echo demo
registry.register(new ClaudeAssistant(), true);  // Default: Claude-powered assistant

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

    const url = new URL(request.url);

    // FreeClimb call webhook - handles incoming calls
    if (url.pathname === '/call' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_API_KEY);
      if (!webhookAuth.valid) {
        return createWebhookUnauthorizedResponse(webhookAuth.error!);
      }

      // Rate limit by IP to prevent flood attacks
      const ip = getIPFromRequest(request);
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `call:${ip}`, RATE_LIMITS.CALL_START);

      if (!rateLimit.allowed) {
        return new Response('Too many call attempts', { status: 429 });
      }

      return handleIncomingCall(request, env);
    }

    // FreeClimb conversation webhook - handles each turn of dialogue
    if (url.pathname === '/conversation' && request.method === 'POST') {
      const webhookAuth = await validateWebhook(request, env.FREECLIMB_API_KEY);
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

      // Re-create request with parsed body for handleConversation
      const newRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(body),
      });

      return handleConversation(newRequest, env, ctx);
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
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleDebugAccount(env);
    }

    // List FreeClimb phone numbers
    if (url.pathname === '/phone-numbers' && request.method === 'GET') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleListPhoneNumbers(env);
    }

    // Setup FreeClimb application and phone number
    if (url.pathname === '/setup' && request.method === 'POST') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleSetup(request, env);
    }

    // Update phone number alias
    if (url.pathname === '/update-number' && request.method === 'POST') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleUpdatePhoneNumber(request, env);
    }

    // Get FreeClimb logs
    if (url.pathname === '/logs' && request.method === 'GET') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleGetLogs(request, env);
    }

    // Update FreeClimb application URLs
    if (url.pathname === '/update-app' && request.method === 'POST') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

      // Rate limit admin operations
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
      const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
      if (!rateLimit.allowed) {
        return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });
      }

      return handleUpdateApplication(request, env);
    }

    // Cost tracking summary
    if (url.pathname === '/costs' && request.method === 'GET') {
      const auth = requireAdminAuth(request, env);
      if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

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

    // Direct ElevenLabs TTS endpoint — called by FreeClimb Play command (TTS_MODE=direct)
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
        const audioBuffer = await callElevenLabs(decodedText, env.ELEVENLABS_API_KEY, voiceId ?? undefined);
        return new Response(audioBuffer, {
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      } catch (err) {
        console.error('ElevenLabs TTS error:', err);
        return new Response('TTS generation failed', { status: 502 });
      }
    }

    // Pre-generated TTS audio cache — served by UUID (V2 streaming path)
    // UUID is unguessable (128-bit random), no additional signing needed
    if (url.pathname === '/tts-cache' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return new Response('Bad request', { status: 400 });

      const audio = await env.RATE_LIMIT_KV.get(`tts:${id}`, 'arrayBuffer');
      if (!audio) return new Response('Not found', { status: 404 });

      return new Response(audio, {
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }

    // V2 redirect chain — called by FreeClimb after playing sentence N, retrieves sentence N+1
    // callId is a FreeClimb-generated ID; unguessable in practice
    if (url.pathname === '/continue' && request.method === 'GET') {
      const callId = url.searchParams.get('callId');
      const n = parseInt(url.searchParams.get('n') ?? '0', 10);

      if (!callId) return new Response('Bad request', { status: 400 });

      const callKey = `stream:${callId}`;
      const nextN = n + 1;
      const origin = new URL(request.url).origin;

      // Poll up to 4 attempts (0ms, 200ms, 400ms, 600ms) for background TTS to finish
      let nextId: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 200));
        nextId = await env.RATE_LIMIT_KV.get(`${callKey}:${nextN}`);
        if (nextId) break;
        const done = await env.RATE_LIMIT_KV.get(`${callKey}:done`);
        if (done) break;
      }

      const transcribeUtterance = {
        TranscribeUtterance: {
          actionUrl: `${origin}/conversation`,
          playBeep: false,
          record: { maxLengthSec: 25, rcrdTerminationSilenceTimeMs: 4000 },
        },
      };

      if (!nextId) {
        // No more sentences — prompt caller for next input
        return Response.json([transcribeUtterance]);
      }

      return Response.json([
        { Play: { file: `${origin}/tts-cache?id=${nextId}` } },
        { Redirect: { actionUrl: `${origin}/continue?callId=${callId}&n=${nextN}` } },
      ]);
    }

    return new Response('Not Found', { status: 404 });
  },
};
