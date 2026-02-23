// Rate limiting using Cloudflare KV

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  maxRequests: number;      // Max requests in window
  windowSeconds: number;    // Time window in seconds
  keyPrefix: string;        // KV key prefix (e.g., 'rl:conv')
}

/**
 * Rate limit check result
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;          // Unix timestamp in milliseconds
  error?: string;
}

/**
 * Predefined rate limit configurations for voxnos
 */
export const RATE_LIMITS = {
  CONVERSATION: { maxRequests: 60, windowSeconds: 60, keyPrefix: 'rl:conv' },  // 60/min per call
  CALL_START: { maxRequests: 20, windowSeconds: 60, keyPrefix: 'rl:call' },   // 20/min per IP
  ADMIN: { maxRequests: 20, windowSeconds: 60, keyPrefix: 'rl:admin' },       // 20/min per key
};

/**
 * Check rate limit using fixed-window counter.
 *
 * Each window is identified by floor(now / windowSeconds), so all requests
 * within the same window share one KV counter. Requires a single KV read + write.
 *
 * @param kv - KV namespace binding
 * @param identifier - Unique identifier (callId, IP, admin key, etc.)
 * @param config - Rate limit configuration
 * @returns Rate limit result
 */
export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // If KV is not available, fail open (allow request)
  if (!kv) {
    console.warn('Rate limit KV not available, allowing request');
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: Date.now() + config.windowSeconds * 1000,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowBucket = Math.floor(nowSeconds / config.windowSeconds);
  const kvKey = `${config.keyPrefix}:${identifier}:${windowBucket}`;
  const resetAt = (windowBucket + 1) * config.windowSeconds * 1000;

  try {
    const countStr = await kv.get(kvKey);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        error: 'Rate limit exceeded',
      };
    }

    await kv.put(kvKey, String(count + 1), { expirationTtl: config.windowSeconds * 2 });

    return {
      allowed: true,
      remaining: config.maxRequests - count - 1,
      resetAt,
    };
  } catch (error) {
    // If KV operation fails, fail open (allow request) but log the error
    console.error('Rate limit check failed:', error);
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt,
    };
  }
}

/**
 * Get rate limit identifier from request
 *
 * @param request - Incoming request
 * @returns IP address from headers
 */
export function getIPFromRequest(request: Request): string {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    request.headers.get('X-Real-IP') ||
    'unknown';

  return ip;
}
