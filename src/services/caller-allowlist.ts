// In-memory caller allowlist — loaded from D1 at startup, refreshable via MCP.
// Empty set = no filtering (all callers allowed). Non-empty = strict allowlist.
// Extracted into its own module to avoid circular imports between index.ts and mcp-server.ts.

import { loadAllowedCallers } from './app-store.js';

let allowedCallers = new Set<string>();

/** Reload the allowed callers set from D1. Returns the new count. */
export async function reloadAllowedCallers(db: D1Database): Promise<number> {
  allowedCallers = await loadAllowedCallers(db);
  return allowedCallers.size;
}

/** Check if a caller is allowed. Returns true if allowlist is empty (disabled) or caller is on the list. */
export function isCallerAllowed(from: string): boolean {
  return allowedCallers.size === 0 || allowedCallers.has(from);
}
