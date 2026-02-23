// Call Detail Records — D1 data access for call_records and call_turns.
// Follows the same pattern as survey-store.ts (pure data access, no app dependencies).
// All write functions are designed for fire-and-forget use — callers should .catch(() => {}).

export interface CallRecordRow {
  id: number;
  call_id: string;
  app_id: string;
  caller: string;
  callee: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  outcome: string;
  turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface CallTurnRow {
  id: number;
  call_id: string;
  seq: number;
  turn_type: string;
  speaker: string;
  content: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface TurnInput {
  callId: string;
  turnType: string;
  speaker: string;
  content?: string;
  meta?: Record<string, unknown>;
}

export interface ListCallOpts {
  appId?: string;
  from?: string;
  to?: string;
  caller?: string;
  limit?: number;
  offset?: number;
}

// --- Call records ---

/** Create a new call record at call start. */
export async function createCallRecord(
  db: D1Database,
  input: { callId: string; appId: string; caller: string; callee: string },
): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO call_records (call_id, app_id, caller, callee, started_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .bind(input.callId, input.appId, input.caller, input.callee)
      .run();
    return true;
  } catch (err) {
    console.error('CDR createCallRecord failed:', err);
    return false;
  }
}

/** Finalize a call record — sets ended_at, duration, outcome, and turn count. */
export async function endCallRecord(
  db: D1Database,
  callId: string,
  outcome: string,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE call_records SET
           ended_at = datetime('now'),
           duration_ms = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER),
           outcome = ?,
           turn_count = (SELECT COUNT(*) FROM call_turns WHERE call_id = ?)
         WHERE call_id = ?`,
      )
      .bind(outcome, callId, callId)
      .run();
    return true;
  } catch (err) {
    console.error('CDR endCallRecord failed:', err);
    return false;
  }
}

/** Accumulate token usage on a call record. */
export async function updateCallTokens(
  db: D1Database,
  callId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<boolean> {
  try {
    await db
      .prepare(
        `UPDATE call_records SET
           total_input_tokens = total_input_tokens + ?,
           total_output_tokens = total_output_tokens + ?
         WHERE call_id = ?`,
      )
      .bind(inputTokens, outputTokens, callId)
      .run();
    return true;
  } catch (err) {
    console.error('CDR updateCallTokens failed:', err);
    return false;
  }
}

/** Get a single call record. */
export async function getCallRecord(db: D1Database, callId: string): Promise<CallRecordRow | null> {
  const row = await db.prepare('SELECT * FROM call_records WHERE call_id = ?').bind(callId).first();
  return row ? parseRecordRow(row as Record<string, unknown>) : null;
}

/** List call records with optional filters and pagination. */
export async function listCallRecords(db: D1Database, opts: ListCallOpts = {}): Promise<CallRecordRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.appId) {
    conditions.push('app_id = ?');
    params.push(opts.appId);
  }
  if (opts.from) {
    conditions.push('started_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push('started_at <= ?');
    params.push(opts.to);
  }
  if (opts.caller) {
    conditions.push('caller = ?');
    params.push(opts.caller);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const { results } = await db
    .prepare(`SELECT * FROM call_records ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all();

  return (results as Record<string, unknown>[]).map(parseRecordRow);
}

// --- Call turns ---

/** Add a single turn. Seq is auto-assigned as next in sequence for the call. */
export async function addTurn(db: D1Database, input: TurnInput): Promise<boolean> {
  try {
    await db
      .prepare(
        `INSERT INTO call_turns (call_id, seq, turn_type, speaker, content, meta)
         VALUES (?, COALESCE((SELECT MAX(seq) FROM call_turns WHERE call_id = ?), -1) + 1, ?, ?, ?, ?)`,
      )
      .bind(
        input.callId,
        input.callId,
        input.turnType,
        input.speaker,
        input.content ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      )
      .run();
    return true;
  } catch (err) {
    console.error('CDR addTurn failed:', err);
    return false;
  }
}

/** Batch-insert multiple turns. Seqs are auto-assigned sequentially. */
export async function addTurnsBatch(db: D1Database, turns: TurnInput[]): Promise<boolean> {
  if (turns.length === 0) return true;
  try {
    // Get current max seq for the call
    const callId = turns[0].callId;
    const maxRow = await db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM call_turns WHERE call_id = ?')
      .bind(callId)
      .first();
    let nextSeq = ((maxRow as Record<string, unknown>)?.max_seq as number ?? -1) + 1;

    const stmts = turns.map((t) => {
      const seq = nextSeq++;
      return db
        .prepare(
          `INSERT INTO call_turns (call_id, seq, turn_type, speaker, content, meta) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(t.callId, seq, t.turnType, t.speaker, t.content ?? null, t.meta ? JSON.stringify(t.meta) : null);
    });

    await db.batch(stmts);
    return true;
  } catch (err) {
    console.error('CDR addTurnsBatch failed:', err);
    return false;
  }
}

/** Get all turns for a call, ordered by sequence. */
export async function getCallTurns(db: D1Database, callId: string): Promise<CallTurnRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM call_turns WHERE call_id = ? ORDER BY seq')
    .bind(callId)
    .all();
  return (results as Record<string, unknown>[]).map(parseTurnRow);
}

// --- Row parsers ---

function parseRecordRow(row: Record<string, unknown>): CallRecordRow {
  return {
    id: row.id as number,
    call_id: row.call_id as string,
    app_id: row.app_id as string,
    caller: row.caller as string,
    callee: row.callee as string,
    started_at: row.started_at as string,
    ended_at: (row.ended_at as string) ?? null,
    duration_ms: (row.duration_ms as number) ?? null,
    outcome: row.outcome as string,
    turn_count: row.turn_count as number,
    total_input_tokens: row.total_input_tokens as number,
    total_output_tokens: row.total_output_tokens as number,
  };
}

function parseTurnRow(row: Record<string, unknown>): CallTurnRow {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try { meta = JSON.parse(row.meta as string) as Record<string, unknown>; } catch { /* skip */ }
  }
  return {
    id: row.id as number,
    call_id: row.call_id as string,
    seq: row.seq as number,
    turn_type: row.turn_type as string,
    speaker: row.speaker as string,
    content: (row.content as string) ?? null,
    meta,
    created_at: row.created_at as string,
  };
}
