// In-memory caller allowlist — loaded from D1 at startup, refreshable via MCP.
// Per-inbound-number with an explicit enable/disable toggle.
// If a number's allowlist is disabled (or has no entries), all callers pass through.
// Extracted into its own module to avoid circular imports between index.ts and mcp-server.ts.

import { loadAllowedCallers, loadAllowlistEnabled, normalizeE164 } from './app-store.js';

// Map<inbound_number, Set<caller_number>>
let allowedCallers = new Map<string, Set<string>>();
// Set of inbound numbers with enforcement enabled
let enabledNumbers = new Set<string>();

/** Reload both the allowed callers map and enabled set from D1. Returns total entry count. */
export async function reloadAllowedCallers(db: D1Database): Promise<number> {
  const [callers, enabled] = await Promise.all([
    loadAllowedCallers(db),
    loadAllowlistEnabled(db),
  ]);
  allowedCallers = callers;
  enabledNumbers = enabled;
  let total = 0;
  for (const set of allowedCallers.values()) total += set.size;
  return total;
}

/** Check if a caller is allowed to reach a specific inbound number.
 *  Returns true if allowlist is not enabled for that number, or if the caller is listed.
 *  Both numbers are normalized to E.164 before comparison.
 *  If either number can't be parsed, fails closed (rejects the call). */
export function isCallerAllowed(inboundNumber: string, callerNumber: string): boolean {
  const inbound = normalizeE164(inboundNumber);
  const caller = normalizeE164(callerNumber);
  if (!inbound || !caller) return false; // can't parse = fail closed
  if (!enabledNumbers.has(inbound)) return true; // enforcement off
  const set = allowedCallers.get(inbound);
  if (!set || set.size === 0) return true; // enabled but no entries = open
  return set.has(caller);
}
