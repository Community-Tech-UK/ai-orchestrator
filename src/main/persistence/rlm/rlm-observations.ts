/**
 * RLM Observations Module
 *
 * CRUD operations for observation and reflection persistence.
 */

import type Database from 'better-sqlite3';
import type { ObservationRow, ReflectionRow } from '../rlm-database.types';

// ============================================
// Observation Operations
// ============================================

/**
 * Add an observation.
 */
export function addObservation(
  db: Database.Database,
  observation: {
    id: string;
    summary: string;
    sourceIds: string[];
    instanceIds: string[];
    themes: string[];
    keyFindings: string[];
    successSignals: number;
    failureSignals: number;
    timestamp: number;
    createdAt: number;
    ttl: number;
    promoted: boolean;
    tokenCount: number;
    embeddingId?: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO observations
      (id, summary, source_ids_json, instance_ids_json, themes_json, key_findings_json,
       success_signals, failure_signals, timestamp, created_at, ttl, promoted, token_count, embedding_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    observation.id,
    observation.summary,
    JSON.stringify(observation.sourceIds),
    JSON.stringify(observation.instanceIds),
    JSON.stringify(observation.themes),
    JSON.stringify(observation.keyFindings),
    observation.successSignals,
    observation.failureSignals,
    observation.timestamp,
    observation.createdAt,
    observation.ttl,
    observation.promoted ? 1 : 0,
    observation.tokenCount,
    observation.embeddingId || null
  );
}

/**
 * Get observations with optional filtering.
 */
export function getObservations(
  db: Database.Database,
  options?: {
    promoted?: boolean;
    since?: number;
    limit?: number;
  }
): ObservationRow[] {
  let query = `SELECT * FROM observations WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.promoted !== undefined) {
    query += ` AND promoted = ?`;
    params.push(options.promoted ? 1 : 0);
  }
  if (options?.since) {
    query += ` AND timestamp >= ?`;
    params.push(options.since);
  }

  query += ` ORDER BY timestamp DESC`;

  if (options?.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params) as ObservationRow[];
}

/**
 * Update an observation (e.g., mark as promoted).
 */
export function updateObservation(
  db: Database.Database,
  id: string,
  updates: {
    promoted?: boolean;
    embeddingId?: string;
  }
): void {
  const setClauses: string[] = [];
  const params: (string | number)[] = [];

  if (updates.promoted !== undefined) {
    setClauses.push('promoted = ?');
    params.push(updates.promoted ? 1 : 0);
  }
  if (updates.embeddingId !== undefined) {
    setClauses.push('embedding_id = ?');
    params.push(updates.embeddingId);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  const stmt = db.prepare(`UPDATE observations SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...params);
}

/**
 * Delete expired observations.
 */
export function deleteExpiredObservations(db: Database.Database): number {
  const now = Date.now();
  const stmt = db.prepare(`DELETE FROM observations WHERE (created_at + ttl) < ?`);
  const result = stmt.run(now);
  return result.changes;
}

// ============================================
// Reflection Operations
// ============================================

/**
 * Add a reflection.
 */
export function addReflection(
  db: Database.Database,
  reflection: {
    id: string;
    title: string;
    insight: string;
    observationIds: string[];
    patterns: unknown[];
    confidence: number;
    applicability: string[];
    createdAt: number;
    ttl: number;
    usageCount: number;
    effectivenessScore: number;
    promotedToProcedural: boolean;
    embeddingId?: string;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO reflections
      (id, title, insight, observation_ids_json, patterns_json, confidence, applicability_json,
       created_at, ttl, usage_count, effectiveness_score, promoted_to_procedural, embedding_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    reflection.id,
    reflection.title,
    reflection.insight,
    JSON.stringify(reflection.observationIds),
    JSON.stringify(reflection.patterns),
    reflection.confidence,
    JSON.stringify(reflection.applicability),
    reflection.createdAt,
    reflection.ttl,
    reflection.usageCount,
    reflection.effectivenessScore,
    reflection.promotedToProcedural ? 1 : 0,
    reflection.embeddingId || null
  );
}

/**
 * Get reflections with optional filtering.
 */
export function getReflections(
  db: Database.Database,
  options?: {
    minConfidence?: number;
    promotedToProcedural?: boolean;
    since?: number;
    limit?: number;
  }
): ReflectionRow[] {
  let query = `SELECT * FROM reflections WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.minConfidence !== undefined) {
    query += ` AND confidence >= ?`;
    params.push(options.minConfidence);
  }
  if (options?.promotedToProcedural !== undefined) {
    query += ` AND promoted_to_procedural = ?`;
    params.push(options.promotedToProcedural ? 1 : 0);
  }
  if (options?.since) {
    query += ` AND created_at >= ?`;
    params.push(options.since);
  }

  query += ` ORDER BY confidence DESC, effectiveness_score DESC`;

  if (options?.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params) as ReflectionRow[];
}

/**
 * Update a reflection.
 */
export function updateReflection(
  db: Database.Database,
  id: string,
  updates: {
    usageCount?: number;
    effectivenessScore?: number;
    promotedToProcedural?: boolean;
    embeddingId?: string;
  }
): void {
  const setClauses: string[] = [];
  const params: (string | number)[] = [];

  if (updates.usageCount !== undefined) {
    setClauses.push('usage_count = ?');
    params.push(updates.usageCount);
  }
  if (updates.effectivenessScore !== undefined) {
    setClauses.push('effectiveness_score = ?');
    params.push(updates.effectivenessScore);
  }
  if (updates.promotedToProcedural !== undefined) {
    setClauses.push('promoted_to_procedural = ?');
    params.push(updates.promotedToProcedural ? 1 : 0);
  }
  if (updates.embeddingId !== undefined) {
    setClauses.push('embedding_id = ?');
    params.push(updates.embeddingId);
  }

  if (setClauses.length === 0) return;

  params.push(id);
  const stmt = db.prepare(`UPDATE reflections SET ${setClauses.join(', ')} WHERE id = ?`);
  stmt.run(...params);
}

/**
 * Delete expired reflections.
 */
export function deleteExpiredReflections(db: Database.Database): number {
  const now = Date.now();
  const stmt = db.prepare(`DELETE FROM reflections WHERE (created_at + ttl) < ? AND promoted_to_procedural = 0`);
  const result = stmt.run(now);
  return result.changes;
}

/**
 * Get observation statistics.
 */
export function getObservationStats(db: Database.Database): {
  totalObservations: number;
  totalReflections: number;
  promotedReflections: number;
  averageConfidence: number;
  averageEffectiveness: number;
} {
  const obsCount = db.prepare(`SELECT COUNT(*) as count FROM observations`).get() as { count: number };
  const refCount = db.prepare(`SELECT COUNT(*) as count FROM reflections`).get() as { count: number };
  const promotedCount = db.prepare(
    `SELECT COUNT(*) as count FROM reflections WHERE promoted_to_procedural = 1`
  ).get() as { count: number };
  const avgConf = db.prepare(
    `SELECT COALESCE(AVG(confidence), 0) as avg FROM reflections`
  ).get() as { avg: number };
  const avgEff = db.prepare(
    `SELECT COALESCE(AVG(effectiveness_score), 0) as avg FROM reflections`
  ).get() as { avg: number };

  return {
    totalObservations: obsCount.count,
    totalReflections: refCount.count,
    promotedReflections: promotedCount.count,
    averageConfidence: avgConf.avg,
    averageEffectiveness: avgEff.avg,
  };
}
