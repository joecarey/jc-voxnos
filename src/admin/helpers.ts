// Admin request helpers — auth gate and D1 availability check.

import type { Env } from '../engine/types.js';
import { requireAdminAuth, createUnauthorizedResponse } from '../platform/auth.js';
import { checkRateLimit, RATE_LIMITS } from '../platform/rate-limit.js';

/** Returns a 401/429 Response if the request fails auth or rate limiting, null if OK. */
export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const auth = requireAdminAuth(request, env);
  if (!auth.authorized) return createUnauthorizedResponse(auth.error!);

  const authHeader = request.headers.get('Authorization');
  const apiKey = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || 'unknown';
  const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, `admin:${apiKey.substring(0, 16)}`, RATE_LIMITS.ADMIN);
  if (!rateLimit.allowed) return new Response('Admin rate limit exceeded', { status: 429, headers: { 'Retry-After': '60' } });

  return null;
}

/** Returns a 501 Response if D1 is not configured, null if available. */
export function requireD1(env: Env): Response | null {
  if (!env.DB) return Response.json({ error: 'D1 not configured' }, { status: 501 });
  return null;
}
