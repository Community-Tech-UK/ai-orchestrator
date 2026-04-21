/**
 * RLM Learning Module
 *
 * Outcomes, patterns, experiences, and insights operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { OutcomeRow, PatternRow, ExperienceRow, InsightRow } from '../rlm-database.types';

// ============================================
// Outcome Operations
// ============================================

/**
 * Add an outcome.
 */
export function addOutcome(
  db: SqliteDriver,
  outcome: {
    id: string;
    taskType: string;
    success: boolean;
    timestamp: number;
    durationMs?: number;
    tokenUsage?: number;
    agentId?: string;
    model?: string;
    errorType?: string;
    promptHash?: string;
    tools?: string[];
    metadata?: Record<string, unknown>;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO outcomes
      (id, task_type, success, timestamp, duration_ms, token_usage, agent_id,
       model, error_type, prompt_hash, tools_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    outcome.id,
    outcome.taskType,
    outcome.success ? 1 : 0,
    outcome.timestamp,
    outcome.durationMs || null,
    outcome.tokenUsage || null,
    outcome.agentId || null,
    outcome.model || null,
    outcome.errorType || null,
    outcome.promptHash || null,
    outcome.tools ? JSON.stringify(outcome.tools) : null,
    outcome.metadata ? JSON.stringify(outcome.metadata) : null
  );
}

/**
 * Get outcomes with optional filtering.
 */
export function getOutcomes(
  db: SqliteDriver,
  options?: {
    taskType?: string;
    agentId?: string;
    since?: number;
    limit?: number;
  }
): OutcomeRow[] {
  let query = `SELECT * FROM outcomes WHERE 1=1`;
  const params: (string | number)[] = [];

  if (options?.taskType) {
    query += ` AND task_type = ?`;
    params.push(options.taskType);
  }
  if (options?.agentId) {
    query += ` AND agent_id = ?`;
    params.push(options.agentId);
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
  return stmt.all(...params) as OutcomeRow[];
}

// ============================================
// Pattern Operations
// ============================================

/**
 * Upsert a pattern.
 */
export function upsertPattern(
  db: SqliteDriver,
  pattern: {
    id: string;
    type: string;
    key: string;
    effectiveness: number;
    sampleSize: number;
    metadata?: Record<string, unknown>;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO patterns (id, type, key, effectiveness, sample_size, last_updated, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, key) DO UPDATE SET
      effectiveness = excluded.effectiveness,
      sample_size = excluded.sample_size,
      last_updated = excluded.last_updated,
      metadata_json = excluded.metadata_json
  `);
  stmt.run(
    pattern.id,
    pattern.type,
    pattern.key,
    pattern.effectiveness,
    pattern.sampleSize,
    Date.now(),
    pattern.metadata ? JSON.stringify(pattern.metadata) : null
  );
}

/**
 * Get patterns, optionally filtered by type.
 */
export function getPatterns(db: SqliteDriver, type?: string): PatternRow[] {
  if (type) {
    const stmt = db.prepare(`
      SELECT * FROM patterns WHERE type = ? ORDER BY effectiveness DESC
    `);
    return stmt.all(type) as PatternRow[];
  }
  const stmt = db.prepare(`SELECT * FROM patterns ORDER BY effectiveness DESC`);
  return stmt.all() as PatternRow[];
}

// ============================================
// Experience Operations
// ============================================

/**
 * Upsert an experience.
 */
export function upsertExperience(
  db: SqliteDriver,
  experience: {
    id: string;
    taskType: string;
    successCount: number;
    failureCount: number;
    successPatterns?: string[];
    failurePatterns?: string[];
    examplePrompts?: string[];
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO experiences
      (id, task_type, success_count, failure_count, success_patterns_json,
       failure_patterns_json, example_prompts_json, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_type) DO UPDATE SET
      success_count = excluded.success_count,
      failure_count = excluded.failure_count,
      success_patterns_json = excluded.success_patterns_json,
      failure_patterns_json = excluded.failure_patterns_json,
      example_prompts_json = excluded.example_prompts_json,
      last_updated = excluded.last_updated
  `);
  stmt.run(
    experience.id,
    experience.taskType,
    experience.successCount,
    experience.failureCount,
    experience.successPatterns ? JSON.stringify(experience.successPatterns) : null,
    experience.failurePatterns ? JSON.stringify(experience.failurePatterns) : null,
    experience.examplePrompts ? JSON.stringify(experience.examplePrompts) : null,
    Date.now()
  );
}

/**
 * Get an experience by task type.
 */
export function getExperience(db: SqliteDriver, taskType: string): ExperienceRow | null {
  const stmt = db.prepare(`SELECT * FROM experiences WHERE task_type = ?`);
  return stmt.get(taskType) as ExperienceRow | null;
}

/**
 * Get all experiences.
 */
export function getAllExperiences(db: SqliteDriver): ExperienceRow[] {
  const stmt = db.prepare(`SELECT * FROM experiences ORDER BY last_updated DESC`);
  return stmt.all() as ExperienceRow[];
}

// ============================================
// Insight Operations
// ============================================

/**
 * Add an insight.
 */
export function addInsight(
  db: SqliteDriver,
  insight: {
    id: string;
    type: string;
    title: string;
    description?: string;
    confidence: number;
    supportingPatterns?: string[];
    expiresAt?: number;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO insights
      (id, type, title, description, confidence, supporting_patterns_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    insight.id,
    insight.type,
    insight.title,
    insight.description || null,
    insight.confidence,
    insight.supportingPatterns ? JSON.stringify(insight.supportingPatterns) : null,
    Date.now(),
    insight.expiresAt || null
  );
}

/**
 * Get insights, optionally filtered by type.
 */
export function getInsights(db: SqliteDriver, type?: string): InsightRow[] {
  const now = Date.now();
  if (type) {
    const stmt = db.prepare(`
      SELECT * FROM insights
      WHERE type = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY confidence DESC
    `);
    return stmt.all(type, now) as InsightRow[];
  }
  const stmt = db.prepare(`
    SELECT * FROM insights
    WHERE expires_at IS NULL OR expires_at > ?
    ORDER BY confidence DESC
  `);
  return stmt.all(now) as InsightRow[];
}
