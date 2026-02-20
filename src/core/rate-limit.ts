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
  TOOL_WEATHER: { maxRequests: 30, windowSeconds: 60, keyPrefix: 'rl:weather' }, // 30/min global
  TOOL_COGNOS: { maxRequests: 20, windowSeconds: 60, keyPrefix: 'rl:cognos' },   // 20/min global
};

/**
 * Check rate limit using sliding window algorithm
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

  const now = Date.now();
  const windowStart = now - config.windowSeconds * 1000;

  // Create time bucket (round to nearest second)
  const timeBucket = Math.floor(now / 1000);
  const kvKey = `${config.keyPrefix}:${identifier}:${timeBucket}`;

  try {
    // Get current count for this second
    const currentCountStr = await kv.get(kvKey);
    const currentCount = currentCountStr ? parseInt(currentCountStr, 10) : 0;

    // Count requests in the sliding window
    let totalCount = currentCount;

    // Check previous buckets within the window (last N seconds)
    const bucketsToCheck = Math.min(10, config.windowSeconds); // Check last 10 seconds
    for (let i = 1; i <= bucketsToCheck; i++) {
      const prevBucket = timeBucket - i;
      const prevKey = `${config.keyPrefix}:${identifier}:${prevBucket}`;
      const prevCountStr = await kv.get(prevKey);
      if (prevCountStr) {
        totalCount += parseInt(prevCountStr, 10);
      }
    }

    // Check if limit exceeded
    if (totalCount >= config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: now + config.windowSeconds * 1000,
        error: 'Rate limit exceeded',
      };
    }

    // Increment counter for current bucket
    const newCount = currentCount + 1;
    await kv.put(
      kvKey,
      String(newCount),
      { expirationTtl: config.windowSeconds + 60 } // TTL with 60s buffer
    );

    return {
      allowed: true,
      remaining: config.maxRequests - totalCount - 1,
      resetAt: now + config.windowSeconds * 1000,
    };
  } catch (error) {
    // If KV operation fails, fail open (allow request) but log the error
    console.error('Rate limit check failed:', error);
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: now + config.windowSeconds * 1000,
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
