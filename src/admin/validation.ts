// Input validation for app definitions, survey configs, and phone routes.

import { toolRegistry } from '../tools/registry.js';
import { registry } from '../engine/registry.js';

const VALID_QUESTION_TYPES = new Set(['yes_no', 'scale', 'open']);
const VALID_APP_TYPES = new Set(['conversational', 'survey']);

export function validateAppInput(body: Record<string, unknown>): string | null {
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

export function validatePhoneRouteInput(body: Record<string, unknown>): string | null {
  if (typeof body.phone_number !== 'string' || !body.phone_number.trim()) return 'phone_number is required';
  if (typeof body.app_id !== 'string' || !body.app_id.trim()) return 'app_id is required';
  if (!registry.get(body.app_id)) return `app_id "${body.app_id}" not found in registry`;
  if (body.label !== undefined && body.label !== null && typeof body.label !== 'string') return 'label must be a string';
  return null;
}
