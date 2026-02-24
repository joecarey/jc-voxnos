// Voxnos - Platform for building speech-enabled voice applications

import { registry } from './engine/registry.js';
import { EchoApp } from './apps/echo.js';
import { AvaAssistant } from './apps/ava.js';
import { RitaAssistant } from './apps/rita.js';
import { OttoAssistant } from './apps/otto.js';
import { ConversationalApp } from './engine/conversational-app.js';
import type { AssistantConfig } from './engine/conversational-app.js';
import { SurveyApp } from './engine/survey-app.js';
import type { SurveyConfig } from './engine/survey-app.js';
import type { Env } from './engine/types.js';
import { validateEnv, getEnvSetupInstructions } from './platform/env.js';
import { requireAdminAuth, createUnauthorizedResponse } from './platform/auth.js';
import { validateWebhook, createWebhookUnauthorizedResponse } from './platform/webhook-auth.js';
import { toolRegistry } from './tools/registry.js';
import { WeatherTool } from './tools/weather.js';
import { CognosTool } from './tools/cognos.js';
import { TransferTool } from './tools/transfer.js';
import { checkRateLimit, getIPFromRequest, RATE_LIMITS } from './platform/rate-limit.js';
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
} from './telephony/routes.js';
import { listSurveyResults, getSurveyResult } from './services/survey-store.js';
import { listCallRecords, getCallRecord, getCallTurns } from './services/cdr-store.js';
import {
  loadAllActiveApps, loadAppDefinition, saveAppDefinition,
  deleteAppDefinition, listAppDefinitions,
  loadPhoneRoutes, savePhoneRoute, deletePhoneRoute,
} from './services/app-store.js';
import type { AppDefinitionRow } from './services/app-store.js';
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
  registry.register(new OttoAssistant());

  // Load all app definitions from D1 (conversational + survey)
  if (env.DB) {
    try {
      const defs = await loadAllActiveApps(env.DB);
      for (const def of defs) {
        registerAppFromDefinition(def);
      }
      // Load phone routes
      const routes = await loadPhoneRoutes(env.DB);
      for (const route of routes) {
        registry.setPhoneRoute(route.phone_number, route.app_id);
      }
      if (defs.length) {
        console.log(JSON.stringify({ event: 'apps_loaded', count: defs.length, ids: defs.map(d => d.id) }));
      }
    } catch (err) {
      console.error('Failed to load app definitions from D1, falling back to static:', err);
      // Fallback: register code-defined Ava and Rita
      registry.register(new AvaAssistant(), { isDefault: true });
      registry.register(new RitaAssistant());
    }
  } else {
    // No D1 — use code-defined apps
    registry.register(new AvaAssistant(), { isDefault: true });
    registry.register(new RitaAssistant());
  }

  setupDone = true;
}

/** Instantiate and register an app from a D1 definition row. */
function registerAppFromDefinition(def: AppDefinitionRow): void {
  const opts = { dynamic: true, isDefault: def.is_default };
  if (def.type === 'conversational') {
    const c = def.config as Record<string, unknown>;
    const config: AssistantConfig = {
      id: def.id,
      name: def.name,
      systemPrompt: c.systemPrompt as string,
      greetings: c.greetings as string[],
      fillers: c.fillers as string[],
      goodbyes: c.goodbyes as string[],
      retries: c.retries as string[] | undefined,
      model: c.model as string | undefined,
      tools: c.tools as string[] | undefined,
      voice: c.voice as string | undefined,
    };
    registry.register(new ConversationalApp(config), opts);
  } else if (def.type === 'survey') {
    const c = def.config as Record<string, unknown>;
    const config: SurveyConfig = {
      id: def.id,
      name: def.name,
      greeting: c.greeting as string,
      closing: c.closing as string,
      questions: c.questions as SurveyConfig['questions'],
      retries: c.retries as string[] | undefined,
      voice: c.voice as string | undefined,
    };
    registry.register(new SurveyApp(config), opts);
  } else {
    console.warn(`Unknown app type "${def.type}" for app "${def.id}", skipping`);
  }
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

const VALID_QUESTION_TYPES = new Set(['yes_no', 'scale', 'open']);
const VALID_APP_TYPES = new Set(['conversational', 'survey']);

function validateAppInput(body: Record<string, unknown>): string | null {
  if (typeof body.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(body.id)) {
    return 'id must be 1-32 lowercase alphanumeric/hyphen characters';
  }
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (!VALID_APP_TYPES.has(body.type as string)) return 'type must be conversational or survey';
  if (!body.config || typeof body.config !== 'object') return 'config is required';

  const config = body.config as Record<string, unknown>;

  if (body.type === 'conversational') {
    return validateConversationalConfig(config);
  }
  return validateSurveyConfig(config);
}

function validateConversationalConfig(c: Record<string, unknown>): string | null {
  if (typeof c.systemPrompt !== 'string' || !c.systemPrompt.trim()) return 'config.systemPrompt is required';
  if (!Array.isArray(c.greetings) || c.greetings.length === 0) return 'config.greetings must be a non-empty string array';
  if (!c.greetings.every((g: unknown) => typeof g === 'string')) return 'config.greetings must contain only strings';
  if (!Array.isArray(c.fillers) || c.fillers.length === 0) return 'config.fillers must be a non-empty string array';
  if (!c.fillers.every((f: unknown) => typeof f === 'string')) return 'config.fillers must contain only strings';
  if (!Array.isArray(c.goodbyes) || c.goodbyes.length === 0) return 'config.goodbyes must be a non-empty string array';
  if (!c.goodbyes.every((g: unknown) => typeof g === 'string')) return 'config.goodbyes must contain only strings';
  if (c.retries !== undefined && c.retries !== null) {
    if (!Array.isArray(c.retries) || !c.retries.every((r: unknown) => typeof r === 'string')) {
      return 'config.retries must be an array of strings';
    }
  }
  if (c.model !== undefined && typeof c.model !== 'string') return 'config.model must be a string';
  if (c.voice !== undefined && c.voice !== null && typeof c.voice !== 'string') return 'config.voice must be a string';
  if (c.tools !== undefined && c.tools !== null) {
    if (!Array.isArray(c.tools) || !c.tools.every((t: unknown) => typeof t === 'string')) {
      return 'config.tools must be an array of strings';
    }
    for (const name of c.tools as string[]) {
      if (!toolRegistry.get(name)) return `config.tools: unknown tool "${name}"`;
    }
  }
  return null;
}

function validateSurveyConfig(c: Record<string, unknown>): string | null {
  if (typeof c.greeting !== 'string' || !c.greeting.trim()) return 'config.greeting is required';
  if (typeof c.closing !== 'string' || !c.closing.trim()) return 'config.closing is required';
  if (!Array.isArray(c.questions) || c.questions.length === 0) return 'config.questions must be a non-empty array';
  for (let i = 0; i < c.questions.length; i++) {
    const q = c.questions[i] as Record<string, unknown>;
    if (typeof q.label !== 'string' || !q.label.trim()) return `config.questions[${i}].label is required`;
    if (typeof q.text !== 'string' || !q.text.trim()) return `config.questions[${i}].text is required`;
    if (!VALID_QUESTION_TYPES.has(q.type as string)) return `config.questions[${i}].type must be yes_no, scale, or open`;
  }
  if (c.retries !== undefined && c.retries !== null) {
    if (!Array.isArray(c.retries) || !c.retries.every((r: unknown) => typeof r === 'string')) {
      return 'config.retries must be an array of strings';
    }
  }
  if (c.voice !== undefined && c.voice !== null && typeof c.voice !== 'string') return 'config.voice must be a string';
  return null;
}

function validatePhoneRouteInput(body: Record<string, unknown>): string | null {
  if (typeof body.phone_number !== 'string' || !body.phone_number.trim()) return 'phone_number is required';
  if (typeof body.app_id !== 'string' || !body.app_id.trim()) return 'app_id is required';
  if (!registry.get(body.app_id)) return `app_id "${body.app_id}" not found in registry`;
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') return 'label must be a string';
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

    await setup(env);

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

    // Survey results — single result by ID (must match before the list route)
    if (url.pathname.startsWith('/survey-results/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const idStr = url.pathname.split('/')[2];
      const id = parseInt(idStr, 10);
      if (isNaN(id)) return Response.json({ error: 'Invalid ID' }, { status: 400 });

      const result = await getSurveyResult(env.DB, id);
      if (!result) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(result);
    }

    // Survey results — list with optional filters
    if (url.pathname === '/survey-results' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const surveyId = url.searchParams.get('survey') ?? undefined;
      const from = url.searchParams.get('from') ?? undefined;
      const to = url.searchParams.get('to') ?? undefined;
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;

      const results = await listSurveyResults(env.DB, { surveyId, from, to, limit, offset });
      return Response.json({ results, count: results.length });
    }

    // CDR — single call detail with turns
    if (url.pathname.startsWith('/cdr/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const callId = url.pathname.slice('/cdr/'.length);
      if (!callId) return Response.json({ error: 'Missing callId' }, { status: 400 });

      const record = await getCallRecord(env.DB, callId);
      if (!record) return Response.json({ error: 'Not found' }, { status: 404 });
      const turns = await getCallTurns(env.DB, callId);
      return Response.json({ record, turns });
    }

    // CDR — list call records with optional filters
    if (url.pathname === '/cdr' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const appId = url.searchParams.get('app_id') ?? undefined;
      const from = url.searchParams.get('from') ?? undefined;
      const to = url.searchParams.get('to') ?? undefined;
      const caller = url.searchParams.get('caller') ?? undefined;
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;

      const records = await listCallRecords(env.DB, { appId, from, to, caller, limit, offset });
      return Response.json({ records, count: records.length });
    }

    // App definitions — single definition by ID
    if (url.pathname.startsWith('/apps/definitions/') && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const appId = url.pathname.split('/')[3];
      if (!appId) return Response.json({ error: 'Missing app ID' }, { status: 400 });

      const def = await loadAppDefinition(env.DB, appId);
      if (!def) return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json(def);
    }

    // App definitions — delete (soft-delete)
    if (url.pathname.startsWith('/apps/definitions/') && request.method === 'DELETE') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const appId = url.pathname.split('/')[3];
      if (!appId) return Response.json({ error: 'Missing app ID' }, { status: 400 });

      const deleted = await deleteAppDefinition(env.DB, appId);
      if (!deleted) return Response.json({ error: 'Not found or already inactive' }, { status: 404 });

      registry.remove(appId);
      return Response.json({ success: true, id: appId });
    }

    // App definitions — list all (active + inactive)
    if (url.pathname === '/apps/definitions' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const definitions = await listAppDefinitions(env.DB);
      return Response.json({ definitions, count: definitions.length });
    }

    // App definitions — create or update
    if (url.pathname === '/apps/definitions' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const body = await request.json() as Record<string, unknown>;
      const validationError = validateAppInput(body);
      if (validationError) return Response.json({ error: validationError }, { status: 400 });

      const saved = await saveAppDefinition(env.DB, {
        id: body.id as string,
        name: body.name as string,
        type: body.type as 'conversational' | 'survey',
        config: body.config as Record<string, unknown>,
        is_default: body.is_default as boolean | undefined,
      });
      if (!saved) return Response.json({ error: 'Failed to save app definition' }, { status: 500 });

      // Reload this app in-memory so it takes effect immediately
      registry.remove(body.id as string);
      const def = await loadAppDefinition(env.DB, body.id as string);
      if (def) registerAppFromDefinition(def);

      return Response.json({ success: true, id: body.id });
    }

    // Phone routes — list all
    if (url.pathname === '/phone-routes' && request.method === 'GET') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const routes = await loadPhoneRoutes(env.DB);
      return Response.json({ routes, count: routes.length });
    }

    // Phone routes — create or update
    if (url.pathname === '/phone-routes' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const body = await request.json() as Record<string, unknown>;
      const routeError = validatePhoneRouteInput(body);
      if (routeError) return Response.json({ error: routeError }, { status: 400 });

      const saved = await savePhoneRoute(env.DB, {
        phoneNumber: body.phone_number as string,
        appId: body.app_id as string,
        label: body.label as string | undefined,
      });
      if (!saved) return Response.json({ error: 'Failed to save phone route' }, { status: 500 });

      registry.setPhoneRoute(body.phone_number as string, body.app_id as string);
      return Response.json({ success: true, phone_number: body.phone_number, app_id: body.app_id });
    }

    // Phone routes — delete
    if (url.pathname.startsWith('/phone-routes/') && request.method === 'DELETE') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      const phoneNumber = decodeURIComponent(url.pathname.split('/')[2]);
      if (!phoneNumber) return Response.json({ error: 'Missing phone number' }, { status: 400 });

      const deleted = await deletePhoneRoute(env.DB, phoneNumber);
      if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 });

      registry.removePhoneRoute(phoneNumber);
      return Response.json({ success: true, phone_number: phoneNumber });
    }

    // Reload all app definitions and phone routes from D1
    if (url.pathname === '/reload-apps' && request.method === 'POST') {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });

      registry.removeDynamic();
      const defs = await loadAllActiveApps(env.DB);
      for (const def of defs) {
        registerAppFromDefinition(def);
      }
      const routes = await loadPhoneRoutes(env.DB);
      for (const route of routes) {
        registry.setPhoneRoute(route.phone_number, route.app_id);
      }
      return Response.json({ success: true, apps: defs.length, routes: routes.length, ids: defs.map(d => d.id) });
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

      // Poll for background TTS to finish. Keeps polling as long as the stream
      // is still alive (`:pending` marker set by processRemainingStream on entry).
      // Max 25 × 500ms = 12.5s; exits early on `:done` or when sentence is found.
      // Tool-heavy turns (cognos briefs) need ~8-12s total so we must not bail early.
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
        // If no :pending marker exists, the stream never started or already finished
        // without writing :done — no point waiting further.
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
