/**
 * RLM Sessions Module
 *
 * Session operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { RLMSessionRow } from '../rlm-database.types';

/**
 * Create a new session.
 */
export function createSession(
  db: SqliteDriver,
  session: {
    id: string;
    storeId: string;
    instanceId: string;
    estimatedDirectTokens: number;
  }
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO rlm_sessions
      (id, store_id, instance_id, started_at, last_activity_at, estimated_direct_tokens)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    session.id,
    session.storeId,
    session.instanceId,
    now,
    now,
    session.estimatedDirectTokens
  );
}

/**
 * Get a session by ID.
 */
export function getSession(db: SqliteDriver, sessionId: string): RLMSessionRow | null {
  const stmt = db.prepare(`SELECT * FROM rlm_sessions WHERE id = ?`);
  return stmt.get(sessionId) as RLMSessionRow | null;
}

/**
 * List sessions, optionally filtered by store.
 */
export function listSessions(db: SqliteDriver, storeId?: string): RLMSessionRow[] {
  if (storeId) {
    const stmt = db.prepare(`
      SELECT * FROM rlm_sessions WHERE store_id = ? ORDER BY started_at DESC
    `);
    return stmt.all(storeId) as RLMSessionRow[];
  }
  const stmt = db.prepare(`SELECT * FROM rlm_sessions ORDER BY started_at DESC`);
  return stmt.all() as RLMSessionRow[];
}

/**
 * Update a session.
 */
export function updateSession(
  db: SqliteDriver,
  sessionId: string,
  updates: {
    totalQueries?: number;
    totalRootTokens?: number;
    totalSubQueryTokens?: number;
    tokenSavingsPercent?: number;
    queriesJson?: string;
    recursiveCallsJson?: string;
  }
): void {
  const setClause: string[] = ['last_activity_at = ?'];
  const params: (string | number)[] = [Date.now()];

  if (updates.totalQueries !== undefined) {
    setClause.push('total_queries = ?');
    params.push(updates.totalQueries);
  }
  if (updates.totalRootTokens !== undefined) {
    setClause.push('total_root_tokens = ?');
    params.push(updates.totalRootTokens);
  }
  if (updates.totalSubQueryTokens !== undefined) {
    setClause.push('total_sub_query_tokens = ?');
    params.push(updates.totalSubQueryTokens);
  }
  if (updates.tokenSavingsPercent !== undefined) {
    setClause.push('token_savings_percent = ?');
    params.push(updates.tokenSavingsPercent);
  }
  if (updates.queriesJson !== undefined) {
    setClause.push('queries_json = ?');
    params.push(updates.queriesJson);
  }
  if (updates.recursiveCallsJson !== undefined) {
    setClause.push('recursive_calls_json = ?');
    params.push(updates.recursiveCallsJson);
  }

  params.push(sessionId);

  const stmt = db.prepare(`
    UPDATE rlm_sessions SET ${setClause.join(', ')} WHERE id = ?
  `);
  stmt.run(...params);
}

/**
 * End a session.
 */
export function endSession(db: SqliteDriver, sessionId: string): void {
  const stmt = db.prepare(`
    UPDATE rlm_sessions SET ended_at = ?, last_activity_at = ? WHERE id = ?
  `);
  const now = Date.now();
  stmt.run(now, now, sessionId);
}
