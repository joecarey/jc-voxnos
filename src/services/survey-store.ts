// Survey result storage — D1 data access for completed survey responses.
// App definitions have moved to app-store.ts.

import type { SurveyAnswer } from '../engine/survey-app.js';

export interface SurveyResultRow {
  id: number;
  survey_id: string;
  call_id: string;
  caller: string;
  completed_at: string;
  answers: SurveyAnswer[];
  summary: string;
}

interface SurveyResultInput {
  callId: string;
  from: string;
  completedAt: string;
  surveyId: string;
  answers: SurveyAnswer[];
  summary: string;
}

/** Insert a completed survey result. Catches errors to avoid failing the call. */
export async function saveSurveyResult(db: D1Database, result: SurveyResultInput): Promise<boolean> {
  try {
    await db
      .prepare('INSERT INTO survey_results (survey_id, call_id, caller, completed_at, answers, summary) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(result.surveyId, result.callId, result.from, result.completedAt, JSON.stringify(result.answers), result.summary)
      .run();
    return true;
  } catch (err) {
    console.error('D1 saveSurveyResult failed:', err);
    return false;
  }
}

export interface ListOpts {
  surveyId?: string;
  from?: string;  // ISO date, inclusive
  to?: string;    // ISO date, inclusive
  limit?: number;
  offset?: number;
}

/** List survey results with optional filters. */
export async function listSurveyResults(db: D1Database, opts: ListOpts = {}): Promise<SurveyResultRow[]> {
  const conditions: string[] = [];
  const params: string[] = [];

  if (opts.surveyId) {
    conditions.push('survey_id = ?');
    params.push(opts.surveyId);
  }
  if (opts.from) {
    conditions.push('completed_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push('completed_at <= ?');
    params.push(opts.to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = opts.offset ?? 0;

  const sql = `SELECT * FROM survey_results ${where} ORDER BY completed_at DESC LIMIT ? OFFSET ?`;
  params.push(String(limit), String(offset));

  const { results } = await db.prepare(sql).bind(...params).all();
  return (results as Record<string, unknown>[]).map(parseRow);
}

/** Get a single survey result by ID. */
export async function getSurveyResult(db: D1Database, id: number): Promise<SurveyResultRow | null> {
  const row = await db.prepare('SELECT * FROM survey_results WHERE id = ?').bind(id).first();
  return row ? parseRow(row as Record<string, unknown>) : null;
}

function parseRow(row: Record<string, unknown>): SurveyResultRow {
  return {
    id: row.id as number,
    survey_id: row.survey_id as string,
    call_id: row.call_id as string,
    caller: row.caller as string,
    completed_at: row.completed_at as string,
    answers: JSON.parse(row.answers as string) as SurveyAnswer[],
    summary: row.summary as string,
  };
}
