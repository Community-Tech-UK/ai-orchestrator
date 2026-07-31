/**
 * LearningScanCheckpointStore — persistence facade over
 * `learning_scan_checkpoints` for the WS-B8 fail->fix correction scan.
 *
 * Mirrors {@link GovernedProposalStore}'s design rules: lazily binds to the
 * RLM database; if RLM is not initialised (unit tests, early startup) reads
 * return `null`/defaults and writes are skipped fail-soft rather than
 * throwing. One row per workspace scope ('__global__' when unscoped).
 */

import { getLogger } from '../logging/logger';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  getLearningScanCheckpoint,
  upsertLearningScanCheckpoint,
  type LearningScanCheckpoint,
  type UpsertLearningScanCheckpointParams,
} from '../persistence/rlm/rlm-learning-scan-checkpoints';

export type { LearningScanCheckpoint } from '../persistence/rlm/rlm-learning-scan-checkpoints';

const logger = getLogger('LearningScanCheckpointStore');

/** Scope key used when a scan is not restricted to a single workspace. */
export const LEARNING_SCAN_GLOBAL_SCOPE = '__global__';

export class LearningScanCheckpointStore {
  private static instance: LearningScanCheckpointStore | null = null;

  private db: SqliteDriver | null = null;
  private dbResolved = false;

  static getInstance(): LearningScanCheckpointStore {
    if (!LearningScanCheckpointStore.instance) {
      LearningScanCheckpointStore.instance = new LearningScanCheckpointStore();
    }
    return LearningScanCheckpointStore.instance;
  }

  static _resetForTesting(): void {
    LearningScanCheckpointStore.instance = null;
  }

  /** Test seam: bind directly to a database instead of the RLM singleton. */
  _bindDatabaseForTesting(db: SqliteDriver): void {
    this.db = db;
    this.dbResolved = true;
  }

  /** Test seam: simulate a permanently unavailable database. */
  _bindUnavailableForTesting(): void {
    this.db = null;
    this.dbResolved = true;
  }

  private resolveDb(): SqliteDriver | null {
    if (this.db) return this.db;
    if (this.dbResolved) return null;
    this.dbResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) {
        this.dbResolved = false; // retry on next call; RLM may init later
        return null;
      }
      this.db = rlm.getDb();
      return this.db;
    } catch (err) {
      logger.warn('RLM database unavailable; learning scan checkpoint store disabled', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Read the checkpoint for a scope, or `null` when never scanned / DB unavailable. */
  get(scopeKey: string): LearningScanCheckpoint | null {
    const db = this.resolveDb();
    if (!db) return null;
    try {
      return getLearningScanCheckpoint(db, scopeKey);
    } catch (err) {
      logger.warn('get failed (fail-soft)', { scopeKey, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Record the outcome of a completed scan run. Fail-soft: never throws. */
  recordRun(params: UpsertLearningScanCheckpointParams): void {
    const db = this.resolveDb();
    if (!db) return;
    try {
      upsertLearningScanCheckpoint(db, params);
    } catch (err) {
      logger.warn('recordRun failed (fail-soft)', {
        scopeKey: params.scopeKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function getLearningScanCheckpointStore(): LearningScanCheckpointStore {
  return LearningScanCheckpointStore.getInstance();
}
