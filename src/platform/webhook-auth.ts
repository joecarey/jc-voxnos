// Webhook authentication for FreeClimb webhooks
// Implements HMAC-SHA256 signature validation and IP allowlist fallback

/**
 * FreeClimb webhook signature validation result
 */
export interface WebhookValidationResult {
  valid: boolean;
  error?: string;
  method?: 'signature' | 'ip_allowlist';
}

/**
 * FreeClimb IP ranges (Vail Systems, Inc. — FreeClimb's parent)
 */
const FREECLIMB_IP_ALLOWLIST = [
  '63.209.0.0/16',   // Vail Systems / Flexential (ASN 19067) — observed: 63.209.137.92
  '74.63.0.0/16',    // Flexential Colorado (ASN 19067) — observed: 74.63.156.93
];

/**
 * Validate FreeClimb webhook signature using HMAC-SHA256
 *
 * FreeClimb includes signature in headers for webhook security.
 * The signature is computed as:
 *   HMAC-SHA256(signingSecret, requestBody)
 *
 * @param request - The incoming webhook request
 * @param signingSecret - FreeClimb signing secret (typically FREECLIMB_API_KEY)
 * @param signatureHeader - Header name containing signature (default: 'X-FreeClimb-Signature')
 * @returns Validation result indicating if signature is valid
 */
export async function validateWebhookSignature(
  request: Request,
  signingSecret: string,
  signatureHeader: string = 'freeclimb-signature'
): Promise<WebhookValidationResult> {
  const headerValue = request.headers.get(signatureHeader);

  if (!headerValue) {
    return {
      valid: false,
      error: `Missing ${signatureHeader} header`,
    };
  }

  // FreeClimb signature format: "t=<timestamp>,v1=<hmac_hex>"
  const parts = Object.fromEntries(
    headerValue.split(',').map(p => p.split('=') as [string, string])
  );
  const timestamp = parts['t'];
  const receivedHmac = parts['v1'];

  if (!timestamp || !receivedHmac) {
    return {
      valid: false,
      error: 'Malformed signature header',
    };
  }

  // Clone request to read body (body can only be read once)
  const clonedRequest = request.clone();
  const body = await clonedRequest.text();

  // FreeClimb signs: "<timestamp>.<body>"
  const payload = `${timestamp}.${body}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));

  const expectedHmac = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (constantTimeCompare(receivedHmac, expectedHmac)) {
    return {
      valid: true,
      method: 'signature',
    };
  }

  return {
    valid: false,
    error: 'Invalid signature',
  };
}

/**
 * Validate webhook request by IP address allowlist
 *
 * Use this as a fallback if signature validation is not available.
 * Less secure than HMAC validation but better than nothing.
 *
 * @param request - The incoming webhook request
 * @returns Validation result indicating if IP is allowed
 */
export function validateWebhookIP(request: Request): WebhookValidationResult {
  const clientIP = request.headers.get('CF-Connecting-IP') ||
                   request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                   request.headers.get('X-Real-IP');

  if (!clientIP) {
    return {
      valid: false,
      error: 'Could not determine client IP',
    };
  }

  // Simple IP prefix matching
  // In production, use proper CIDR matching library
  const isAllowed = FREECLIMB_IP_ALLOWLIST.some(range => {
    if (range.includes('/')) {
      // CIDR notation - simple prefix match
      const prefix = range.split('/')[0].split('.').slice(0, 2).join('.');
      return clientIP.startsWith(prefix);
    }
    return clientIP === range;
  });

  if (isAllowed) {
    return {
      valid: true,
      method: 'ip_allowlist',
    };
  }

  return {
    valid: false,
    error: `IP ${clientIP} not in allowlist`,
  };
}

/**
 * Validate FreeClimb webhook with signature or IP fallback
 *
 * Tries signature validation first, falls back to IP allowlist.
 *
 * @param request - The incoming webhook request
 * @param signingSecret - FreeClimb signing secret
 * @returns Validation result
 */
export async function validateWebhook(
  request: Request,
  signingSecret: string
): Promise<WebhookValidationResult> {
  // Try signature validation first (most secure)
  const signatureResult = await validateWebhookSignature(request, signingSecret);
  if (signatureResult.valid) {
    return signatureResult;
  }

  // Fallback to IP allowlist
  console.warn('Webhook signature validation failed, falling back to IP allowlist');
  return validateWebhookIP(request);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Helper to create 401 Unauthorized response for webhook validation failures
 */
export function createWebhookUnauthorizedResponse(error: string): Response {
  return new Response(JSON.stringify({ error: 'Webhook validation failed', details: error }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
