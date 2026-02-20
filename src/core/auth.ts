// Admin authentication for voxnos platform

import type { Env } from './types.js';

export interface AuthResult {
  authorized: boolean;
  error?: string;
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Require admin authentication
 *
 * Usage:
 *   const auth = requireAdminAuth(request, env);
 *   if (!auth.authorized) {
 *     return new Response(auth.error, { status: 401 });
 *   }
 *
 * @param request - The incoming request
 * @param env - Environment variables
 * @returns AuthResult indicating if request is authorized
 */
export function requireAdminAuth(request: Request, env: Env): AuthResult {
  const token = extractBearerToken(request);

  if (!token) {
    return {
      authorized: false,
      error: 'Missing Authorization header. Use: Authorization: Bearer <ADMIN_API_KEY>',
    };
  }

  if (token !== env.ADMIN_API_KEY) {
    return {
      authorized: false,
      error: 'Invalid admin API key',
    };
  }

  return {
    authorized: true,
  };
}

/**
 * Helper to create 401 Unauthorized response
 */
export function createUnauthorizedResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
