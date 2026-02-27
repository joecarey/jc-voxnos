// App definition and phone route storage — D1 data access.
// Follows the same pattern as survey-store.ts (pure data access, no app dependencies).

export interface AppDefinitionRow {
  id: string;
  name: string;
  type: 'conversational' | 'survey';
  config: Record<string, unknown>;
  active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AppDefinitionInput {
  id: string;
  name: string;
  type: 'conversational' | 'survey';
  config: Record<string, unknown>;
  is_default?: boolean;
}

export interface PhoneRouteRow {
  phone_number: string;
  app_id: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhoneRouteInput {
  phoneNumber: string;
  appId: string;
  label?: string;
}

// --- App definitions ---

/** Load all active app definitions (startup loader). */
export async function loadAllActiveApps(db: D1Database): Promise<AppDefinitionRow[]> {
  const { results } = await db.prepare('SELECT * FROM app_definitions WHERE active = 1').all();
  return (results as Record<string, unknown>[]).map(parseAppRow);
}

/** Load a single app definition by ID. */
export async function loadAppDefinition(db: D1Database, appId: string): Promise<AppDefinitionRow | null> {
  const row = await db.prepare('SELECT * FROM app_definitions WHERE id = ?').bind(appId).first();
  return row ? parseAppRow(row as Record<string, unknown>) : null;
}

/** Create or update an app definition. Preserves created_at on update. */
export async function saveAppDefinition(db: D1Database, input: AppDefinitionInput): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO app_definitions (id, name, type, config, active, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, COALESCE((SELECT created_at FROM app_definitions WHERE id = ?), datetime('now')), datetime('now'))`
      )
      .bind(input.id, input.name, input.type, JSON.stringify(input.config), input.is_default ? 1 : 0, input.id)
      .run();
    return true;
  } catch (err) {
    console.error('D1 saveAppDefinition failed:', err);
    return false;
  }
}

/** Soft-delete an app definition. */
export async function deleteAppDefinition(db: D1Database, appId: string): Promise<boolean> {
  const { meta } = await db
    .prepare("UPDATE app_definitions SET active = 0, is_default = 0, updated_at = datetime('now') WHERE id = ? AND active = 1")
    .bind(appId)
    .run();
  return (meta.changes ?? 0) > 0;
}

/** List all app definitions (including inactive) for admin use. */
export async function listAppDefinitions(db: D1Database): Promise<AppDefinitionRow[]> {
  const { results } = await db.prepare('SELECT * FROM app_definitions ORDER BY created_at').all();
  return (results as Record<string, unknown>[]).map(parseAppRow);
}

// --- Phone routes ---

/** Load all phone routes (startup loader). */
export async function loadPhoneRoutes(db: D1Database): Promise<PhoneRouteRow[]> {
  const { results } = await db.prepare('SELECT * FROM phone_routes ORDER BY created_at').all();
  return (results as Record<string, unknown>[]).map(parseRouteRow);
}

/** Create or update a phone route. */
export async function savePhoneRoute(db: D1Database, input: PhoneRouteInput): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO phone_routes (phone_number, app_id, label, created_at, updated_at)
         VALUES (?, ?, ?, COALESCE((SELECT created_at FROM phone_routes WHERE phone_number = ?), datetime('now')), datetime('now'))`
      )
      .bind(input.phoneNumber, input.appId, input.label ?? null, input.phoneNumber)
      .run();
    return true;
  } catch (err) {
    console.error('D1 savePhoneRoute failed:', err);
    return false;
  }
}

/** Delete a phone route. */
export async function deletePhoneRoute(db: D1Database, phoneNumber: string): Promise<boolean> {
  const { meta } = await db
    .prepare('DELETE FROM phone_routes WHERE phone_number = ?')
    .bind(phoneNumber)
    .run();
  return (meta.changes ?? 0) > 0;
}

// --- Phone number normalization ---

/** Normalize a phone number to E.164 format (+1XXXXXXXXXX for US numbers).
 *  Handles: 8472742489, 18472742489, +18472742489, (847) 274-2489, etc. */
export function normalizeE164(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (input.startsWith('+')) return input;
  return `+${digits}`;
}

// --- Allowed callers (per inbound number) ---

export interface AllowedCallerRow {
  inbound_number: string;
  caller_number: string;
  label: string | null;
  created_at: string;
}

/** Load all allowed callers into a Map keyed by inbound number for fast lookup. */
export async function loadAllowedCallers(db: D1Database): Promise<Map<string, Set<string>>> {
  const { results } = await db.prepare('SELECT inbound_number, caller_number FROM allowed_callers').all();
  const map = new Map<string, Set<string>>();
  for (const r of results as Record<string, unknown>[]) {
    const inbound = r.inbound_number as string;
    const caller = r.caller_number as string;
    if (!map.has(inbound)) map.set(inbound, new Set());
    map.get(inbound)!.add(caller);
  }
  return map;
}

/** List all allowed callers, optionally filtered by inbound number. */
export async function listAllowedCallers(db: D1Database, inboundNumber?: string): Promise<AllowedCallerRow[]> {
  const query = inboundNumber
    ? db.prepare('SELECT * FROM allowed_callers WHERE inbound_number = ? ORDER BY created_at').bind(normalizeE164(inboundNumber))
    : db.prepare('SELECT * FROM allowed_callers ORDER BY inbound_number, created_at');
  const { results } = await query.all();
  return (results as Record<string, unknown>[]).map(r => ({
    inbound_number: r.inbound_number as string,
    caller_number: r.caller_number as string,
    label: (r.label as string) ?? null,
    created_at: r.created_at as string,
  }));
}

/** Add a caller to the allowlist for a specific inbound number. Numbers are normalized to E.164. */
export async function addAllowedCaller(db: D1Database, inboundNumber: string, callerNumber: string, label?: string): Promise<boolean> {
  try {
    await db
      .prepare('INSERT OR REPLACE INTO allowed_callers (inbound_number, caller_number, label) VALUES (?, ?, ?)')
      .bind(normalizeE164(inboundNumber), normalizeE164(callerNumber), label ?? null)
      .run();
    return true;
  } catch (err) {
    console.error('D1 addAllowedCaller failed:', err);
    return false;
  }
}

/** Remove a caller from the allowlist for a specific inbound number. Numbers are normalized to E.164. */
export async function removeAllowedCaller(db: D1Database, inboundNumber: string, callerNumber: string): Promise<boolean> {
  const { meta } = await db
    .prepare('DELETE FROM allowed_callers WHERE inbound_number = ? AND caller_number = ?')
    .bind(normalizeE164(inboundNumber), normalizeE164(callerNumber))
    .run();
  return (meta.changes ?? 0) > 0;
}

// --- Allowlist toggle (per inbound number) ---

/** Load the set of inbound numbers with allowlist enforcement enabled. */
export async function loadAllowlistEnabled(db: D1Database): Promise<Set<string>> {
  const { results } = await db.prepare('SELECT inbound_number FROM allowlist_enabled').all();
  return new Set((results as Record<string, unknown>[]).map(r => r.inbound_number as string));
}

/** Enable allowlist enforcement for an inbound number. Number is normalized to E.164. */
export async function enableAllowlist(db: D1Database, inboundNumber: string): Promise<boolean> {
  try {
    await db
      .prepare('INSERT OR IGNORE INTO allowlist_enabled (inbound_number) VALUES (?)')
      .bind(normalizeE164(inboundNumber))
      .run();
    return true;
  } catch (err) {
    console.error('D1 enableAllowlist failed:', err);
    return false;
  }
}

/** Disable allowlist enforcement for an inbound number. Number is normalized to E.164. */
export async function disableAllowlist(db: D1Database, inboundNumber: string): Promise<boolean> {
  const { meta } = await db
    .prepare('DELETE FROM allowlist_enabled WHERE inbound_number = ?')
    .bind(normalizeE164(inboundNumber))
    .run();
  return (meta.changes ?? 0) > 0;
}

// --- Row parsers ---

function parseAppRow(row: Record<string, unknown>): AppDefinitionRow {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as 'conversational' | 'survey',
    config: JSON.parse(row.config as string) as Record<string, unknown>,
    active: row.active === 1,
    is_default: row.is_default === 1,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function parseRouteRow(row: Record<string, unknown>): PhoneRouteRow {
  return {
    phone_number: row.phone_number as string,
    app_id: row.app_id as string,
    label: (row.label as string) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
