// Admin endpoint handlers — app definitions, phone routes, survey results, CDR, costs.
// Each handler assumes auth + D1 checks are done by the caller (where applicable).

import { registry } from '../engine/registry.js';
import { ConversationalApp } from '../engine/conversational-app.js';
import type { AssistantConfig } from '../engine/conversational-app.js';
import { SurveyApp } from '../engine/survey-app.js';
import type { SurveyConfig } from '../engine/survey-app.js';
import type { Env } from '../engine/types.js';
import { listSurveyResults, getSurveyResult } from '../services/survey-store.js';
import { listCallRecords, getCallRecord, getCallTurns } from '../services/cdr-store.js';
import {
  loadAllActiveApps, loadAppDefinition, saveAppDefinition,
  deleteAppDefinition, listAppDefinitions,
  loadPhoneRoutes, savePhoneRoute, deletePhoneRoute,
} from '../services/app-store.js';
import type { AppDefinitionRow } from '../services/app-store.js';
import { validateAppInput, validatePhoneRouteInput } from './validation.js';

// --- App definition factory ---

/** Instantiate and register an app from a D1 definition row. */
export function registerAppFromDefinition(def: AppDefinitionRow): void {
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

// --- Costs ---

export async function handleCosts(env: Env): Promise<Response> {
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

// --- Survey results ---

export async function handleGetSurveyResult(url: URL, db: D1Database): Promise<Response> {
  const idStr = url.pathname.split('/')[2];
  const id = parseInt(idStr, 10);
  if (isNaN(id)) return Response.json({ error: 'Invalid ID' }, { status: 400 });

  const result = await getSurveyResult(db, id);
  if (!result) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(result);
}

export async function handleListSurveyResults(url: URL, db: D1Database): Promise<Response> {
  const surveyId = url.searchParams.get('survey') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
  const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;

  const results = await listSurveyResults(db, { surveyId, from, to, limit, offset });
  return Response.json({ results, count: results.length });
}

// --- CDR ---

export async function handleGetCdr(url: URL, db: D1Database): Promise<Response> {
  const callId = url.pathname.slice('/cdr/'.length);
  if (!callId) return Response.json({ error: 'Missing callId' }, { status: 400 });

  const record = await getCallRecord(db, callId);
  if (!record) return Response.json({ error: 'Not found' }, { status: 404 });
  const turns = await getCallTurns(db, callId);
  return Response.json({ record, turns });
}

export async function handleListCdr(url: URL, db: D1Database): Promise<Response> {
  const appId = url.searchParams.get('app_id') ?? undefined;
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const caller = url.searchParams.get('caller') ?? undefined;
  const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
  const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : undefined;

  const records = await listCallRecords(db, { appId, from, to, caller, limit, offset });
  return Response.json({ records, count: records.length });
}

// --- App definitions ---

export async function handleGetAppDefinition(url: URL, db: D1Database): Promise<Response> {
  const appId = url.pathname.split('/')[3];
  if (!appId) return Response.json({ error: 'Missing app ID' }, { status: 400 });

  const def = await loadAppDefinition(db, appId);
  if (!def) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(def);
}

export async function handleDeleteAppDefinition(url: URL, db: D1Database): Promise<Response> {
  const appId = url.pathname.split('/')[3];
  if (!appId) return Response.json({ error: 'Missing app ID' }, { status: 400 });

  const deleted = await deleteAppDefinition(db, appId);
  if (!deleted) return Response.json({ error: 'Not found or already inactive' }, { status: 404 });

  registry.remove(appId);
  return Response.json({ success: true, id: appId });
}

export async function handleListAppDefinitions(db: D1Database): Promise<Response> {
  const definitions = await listAppDefinitions(db);
  return Response.json({ definitions, count: definitions.length });
}

export async function handleCreateAppDefinition(request: Request, db: D1Database): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const validationError = validateAppInput(body);
  if (validationError) return Response.json({ error: validationError }, { status: 400 });

  const saved = await saveAppDefinition(db, {
    id: body.id as string,
    name: body.name as string,
    type: body.type as 'conversational' | 'survey',
    config: body.config as Record<string, unknown>,
    is_default: body.is_default as boolean | undefined,
  });
  if (!saved) return Response.json({ error: 'Failed to save app definition' }, { status: 500 });

  // Reload this app in-memory so it takes effect immediately
  registry.remove(body.id as string);
  const def = await loadAppDefinition(db, body.id as string);
  if (def) registerAppFromDefinition(def);

  return Response.json({ success: true, id: body.id });
}

// --- Phone routes ---

export async function handleListPhoneRoutes(db: D1Database): Promise<Response> {
  const routes = await loadPhoneRoutes(db);
  return Response.json({ routes, count: routes.length });
}

export async function handleCreatePhoneRoute(request: Request, db: D1Database): Promise<Response> {
  const body = await request.json() as Record<string, unknown>;
  const routeError = validatePhoneRouteInput(body);
  if (routeError) return Response.json({ error: routeError }, { status: 400 });

  const saved = await savePhoneRoute(db, {
    phoneNumber: body.phone_number as string,
    appId: body.app_id as string,
    label: body.label as string | undefined,
  });
  if (!saved) return Response.json({ error: 'Failed to save phone route' }, { status: 500 });

  registry.setPhoneRoute(body.phone_number as string, body.app_id as string);
  return Response.json({ success: true, phone_number: body.phone_number, app_id: body.app_id });
}

export async function handleDeletePhoneRoute(url: URL, db: D1Database): Promise<Response> {
  const phoneNumber = decodeURIComponent(url.pathname.split('/')[2]);
  if (!phoneNumber) return Response.json({ error: 'Missing phone number' }, { status: 400 });

  const deleted = await deletePhoneRoute(db, phoneNumber);
  if (!deleted) return Response.json({ error: 'Not found' }, { status: 404 });

  registry.removePhoneRoute(phoneNumber);
  return Response.json({ success: true, phone_number: phoneNumber });
}

// --- Reload ---

export async function handleReloadApps(db: D1Database): Promise<Response> {
  registry.removeDynamic();
  const defs = await loadAllActiveApps(db);
  for (const def of defs) {
    registerAppFromDefinition(def);
  }
  const routes = await loadPhoneRoutes(db);
  for (const route of routes) {
    registry.setPhoneRoute(route.phone_number, route.app_id);
  }
  return Response.json({ success: true, apps: defs.length, routes: routes.length, ids: defs.map(d => d.id) });
}
