// URL validation for SSRF protection

/**
 * Private IP ranges that should be blocked to prevent SSRF attacks
 */
const PRIVATE_IP_RANGES = [
  /^127\./,              // 127.0.0.0/8 - loopback
  /^10\./,               // 10.0.0.0/8 - private
  /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12 - private
  /^192\.168\./,         // 192.168.0.0/16 - private
  /^169\.254\./,         // 169.254.0.0/16 - link-local
  /^0\./,                // 0.0.0.0/8 - reserved
  /^224\./,              // 224.0.0.0/4 - multicast
  /^240\./,              // 240.0.0.0/4 - reserved
];

/**
 * Blocked hostnames to prevent metadata service access
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  '169.254.169.254',     // AWS/GCP metadata
  'metadata.google.internal', // GCP metadata
  '::1',                 // IPv6 loopback
];

/**
 * Result of URL validation
 */
export interface UrlValidationResult {
  allowed: boolean;
  error?: string;
  url?: URL;
}

/**
 * Check if an IP address is in a private range
 */
function isPrivateIP(ip: string): boolean {
  // IPv6 - block loopback and link-local
  if (ip.includes(':')) {
    return ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc00:') || ip.startsWith('fd00:');
  }

  // IPv4 - check against private ranges
  return PRIVATE_IP_RANGES.some(range => range.test(ip));
}

/**
 * Validate a URL to prevent SSRF attacks
 *
 * Blocks:
 * - Private IP addresses
 * - Localhost
 * - Metadata service endpoints
 * - Non-HTTP/HTTPS protocols
 * - Invalid URLs
 *
 * @param urlString - The URL to validate
 * @returns Validation result with allowed status and optional error
 */
export function isAllowedUrl(urlString: string): UrlValidationResult {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    return {
      allowed: false,
      error: 'Invalid URL format',
    };
  }

  // Only allow HTTP and HTTPS
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      allowed: false,
      error: `Protocol ${url.protocol} not allowed. Only http: and https: are permitted.`,
    };
  }

  // Check hostname against blocklist
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return {
      allowed: false,
      error: `Hostname ${hostname} is blocked`,
    };
  }

  // Check if hostname is an IP address
  // IPv4: 4 octets separated by dots
  // IPv6: contains colons
  const isIP = /^[\d.]+$/.test(hostname) || hostname.includes(':');

  if (isIP && isPrivateIP(hostname)) {
    return {
      allowed: false,
      error: `Private IP address ${hostname} is blocked`,
    };
  }

  // Additional check: resolve DNS and validate IP
  // Note: Can't do synchronous DNS resolution in Workers
  // This check catches direct IP access

  return {
    allowed: true,
    url,
  };
}

/**
 * Assert that a URL is allowed, throwing an error if not
 *
 * @param urlString - The URL to validate
 * @throws Error if URL is not allowed
 * @returns Validated URL object
 */
export function assertAllowedUrl(urlString: string): URL {
  const result = isAllowedUrl(urlString);
  if (!result.allowed) {
    throw new Error(`URL validation failed: ${result.error}`);
  }
  return result.url!;
}
