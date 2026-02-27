// In-memory caller allowlist — loaded from D1 at startup, refreshable via MCP.
// Per-inbound-number: each of your phone numbers has its own set of allowed callers.
// If an inbound number has no entries, all callers are allowed to that number.
// Extracted into its own module to avoid circular imports between index.ts and mcp-server.ts.

import { loadAllowedCallers } from './app-store.js';

// Map<inbound_number, Set<caller_number>>
let allowedCallers = new Map<string, Set<string>>();

/** Reload the allowed callers map from D1. Returns total entry count. */
export async function reloadAllowedCallers(db: D1Database): Promise<number> {
  allowedCallers = await loadAllowedCallers(db);
  let total = 0;
  for (const set of allowedCallers.values()) total += set.size;
  return total;
}

/** Check if a caller is allowed to reach a specific inbound number.
 *  Returns true if no allowlist exists for that inbound number (open). */
export function isCallerAllowed(inboundNumber: string, callerNumber: string): boolean {
  const set = allowedCallers.get(inboundNumber);
  if (!set || set.size === 0) return true; // no allowlist for this number = open
  return set.has(callerNumber);
}
