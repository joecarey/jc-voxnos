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

// Register tools
toolRegistry.register(new WeatherTool());
toolRegistry.register(new CognosTool());

// Register apps
registry.register(new EchoApp());                // Simple echo demo
registry.register(new ClaudeAssistant(), true);  // Default: Claude-powered assistant

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      return handleConversation(newRequest, env);
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

    return new Response('Not Found', { status: 404 });
  },
};
