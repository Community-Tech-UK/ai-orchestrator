/**
 * RLM Skill Attribution Module
 *
 * CRUD for skill_activations (one row per skill injection into a session) and
 * skill_controls (persistent per-skill mode honoured by the loader at
 * selection time). Schema: migration 053_skill_attribution.
 *
 * Modes:
 *   'enabled'      — normal: may be auto-selected and injected.
 *   'suggest-only' — may be surfaced as a suggestion, never auto-injected.
 *   'disabled'     — never selected, suggested, or injected.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';

// ---- Types ----------------------------------------------------------------

export type SkillControlMode = 'enabled' | 'suggest-only' | 'disabled';

export type SkillMatchedBy = 'trigger' | 'embedding' | 'explicit';

export interface SkillActivationRow {
  id: string;
  skill_name: string;
  skill_source: string;
  instance_id: string | null;
  session_id: string | null;
  turn_key: string | null;
  matched_by: SkillMatchedBy;
  matched_trigger: string | null;
  match_score: number | null;
  tokens_injected: number;
  auto_selected: number;
  created_at: number;
}

export interface SkillActivation {
  id: string;
  skillName: string;
  skillSource: string;
  instanceId: string | null;
  sessionId: string | null;
  turnKey: string | null;
  matchedBy: SkillMatchedBy;
  matchedTrigger: string | null;
  matchScore: number | null;
  tokensInjected: number;
  autoSelected: boolean;
  createdAt: number;
}

export interface SkillControlRow {
  skill_name: string;
  mode: SkillControlMode;
  reason: string | null;
  updated_at: number;
}

export interface SkillControl {
  skillName: string;
  mode: SkillControlMode;
  reason: string | null;
  updatedAt: number;
}

export interface SkillHealthSummaryEntry {
  skillName: string;
  totalActivations: number;
  totalTokens: number;
  lastUsedAt: number | null;
  byTrigger: number;
  byEmbedding: number;
  byExplicit: number;
  /** Activations followed by an instance error within the correlation window. */
  precededErrors: number;
}

function toActivation(row: SkillActivationRow): SkillActivation {
  return {
    id: row.id,
    skillName: row.skill_name,
    skillSource: row.skill_source,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    turnKey: row.turn_key,
    matchedBy: row.matched_by,
    matchedTrigger: row.matched_trigger,
    matchScore: row.match_score,
    tokensInjected: row.tokens_injected,
    autoSelected: row.auto_selected === 1,
    createdAt: row.created_at,
  };
}

function toControl(row: SkillControlRow): SkillControl {
  return {
    skillName: row.skill_name,
    mode: row.mode,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

// ---- Activations: write ---------------------------------------------------

export interface InsertSkillActivationParams {
  id: string;
  skillName: string;
  skillSource: string;
  instanceId?: string | null;
  sessionId?: string | null;
  turnKey?: string | null;
  matchedBy: SkillMatchedBy;
  matchedTrigger?: string | null;
  matchScore?: number | null;
  tokensInjected: number;
  autoSelected: boolean;
  createdAt: number;
}

export function insertSkillActivation(db: SqliteDriver, params: InsertSkillActivationParams): void {
  db.prepare(`
    INSERT INTO skill_activations
      (id, skill_name, skill_source, instance_id, session_id, turn_key,
       matched_by, matched_trigger, match_score, tokens_injected, auto_selected, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.skillName,
    params.skillSource,
    params.instanceId ?? null,
    params.sessionId ?? null,
    params.turnKey ?? null,
    params.matchedBy,
    params.matchedTrigger ?? null,
    params.matchScore ?? null,
    params.tokensInjected,
    params.autoSelected ? 1 : 0,
    params.createdAt,
  );
}

// ---- Activations: read ----------------------------------------------------

export interface ListSkillActivationsQuery {
  skillName?: string;
  instanceId?: string;
  since?: number;
  limit?: number;
}

export function listSkillActivations(
  db: SqliteDriver,
  query: ListSkillActivationsQuery = {},
): SkillActivation[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (query.skillName) {
    clauses.push('skill_name = ?');
    args.push(query.skillName);
  }
  if (query.instanceId) {
    clauses.push('instance_id = ?');
    args.push(query.instanceId);
  }
  if (query.since !== undefined) {
    clauses.push('created_at >= ?');
    args.push(query.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
  const rows = db.prepare(`
    SELECT * FROM skill_activations
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `).all<SkillActivationRow>(...args);
  return rows.map(toActivation);
}

/** Aggregate per-skill health stats, optionally bounded to a time window. */
export function getSkillHealthSummary(
  db: SqliteDriver,
  since?: number,
): SkillHealthSummaryEntry[] {
  const where = since !== undefined ? 'WHERE created_at >= ?' : '';
  const args = since !== undefined ? [since] : [];
  interface SummaryRow {
    skill_name: string;
    total_activations: number;
    total_tokens: number;
    last_used_at: number | null;
    by_trigger: number;
    by_embedding: number;
    by_explicit: number;
    preceded_errors: number;
  }
  const rows = db.prepare(`
    SELECT
      skill_name,
      COUNT(*) AS total_activations,
      COALESCE(SUM(tokens_injected), 0) AS total_tokens,
      MAX(created_at) AS last_used_at,
      SUM(CASE WHEN matched_by = 'trigger' THEN 1 ELSE 0 END) AS by_trigger,
      SUM(CASE WHEN matched_by = 'embedding' THEN 1 ELSE 0 END) AS by_embedding,
      SUM(CASE WHEN matched_by = 'explicit' THEN 1 ELSE 0 END) AS by_explicit,
      SUM(followed_by_error) AS preceded_errors
    FROM skill_activations
    ${where}
    GROUP BY skill_name
    ORDER BY total_activations DESC
  `).all<SummaryRow>(...args);
  return rows.map((row) => ({
    skillName: row.skill_name,
    totalActivations: row.total_activations,
    totalTokens: row.total_tokens,
    lastUsedAt: row.last_used_at,
    byTrigger: row.by_trigger,
    byEmbedding: row.by_embedding,
    byExplicit: row.by_explicit,
    precededErrors: row.preceded_errors,
  }));
}

/**
 * Mark every recent activation for an instance as followed-by-error.
 * Called when the instance errors/fails within the correlation window.
 * This is correlation, not causation — the UI must label it as such.
 */
export function markActivationsFollowedByError(
  db: SqliteDriver,
  instanceId: string,
  windowMs: number,
  errorAt: number,
): number {
  const result = db.prepare(`
    UPDATE skill_activations
    SET followed_by_error = 1
    WHERE instance_id = ?
      AND followed_by_error = 0
      AND created_at BETWEEN ? AND ?
  `).run(instanceId, errorAt - windowMs, errorAt);
  return result.changes;
}

/** Delete activation rows older than the cutoff; returns rows removed. */
export function pruneSkillActivations(db: SqliteDriver, olderThan: number): number {
  const result = db.prepare(
    'DELETE FROM skill_activations WHERE created_at < ?',
  ).run(olderThan);
  return result.changes;
}

// ---- Controls -------------------------------------------------------------

export function getSkillControl(db: SqliteDriver, skillName: string): SkillControl | null {
  const row = db.prepare(
    'SELECT * FROM skill_controls WHERE skill_name = ?',
  ).get<SkillControlRow>(skillName);
  return row ? toControl(row) : null;
}

export function listSkillControls(db: SqliteDriver): SkillControl[] {
  const rows = db.prepare(
    'SELECT * FROM skill_controls ORDER BY skill_name ASC',
  ).all<SkillControlRow>();
  return rows.map(toControl);
}

export function upsertSkillControl(
  db: SqliteDriver,
  params: { skillName: string; mode: SkillControlMode; reason?: string | null; updatedAt: number },
): void {
  db.prepare(`
    INSERT INTO skill_controls (skill_name, mode, reason, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(skill_name) DO UPDATE SET
      mode = excluded.mode,
      reason = excluded.reason,
      updated_at = excluded.updated_at
  `).run(params.skillName, params.mode, params.reason ?? null, params.updatedAt);
}
