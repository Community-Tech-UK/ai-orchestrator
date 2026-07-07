/**
 * EvidenceStore — durable persistence for evidence-resolver records.
 *
 * Wraps the SQL module `rlm-evidence-records` and adds:
 *   - Fail-soft on every persistence call (a DB error must never break the loop).
 *   - `_resetForTesting()` for unit-test isolation.
 *   - Singleton `getInstance()` that lazily initialises against the production
 *     RLM database.
 *
 * The three evidence states — `fixed`, `verified`, `reviewed` — are distinct
 * queryable values.  The resolver's pure function is not changed; this store is
 * additive only and is called by the coordinator after resolution, or by any
 * other caller that wants to durably record completion evidence.
 *
 * State semantics (matches rlm-schema migration 035):
 *   'fixed'    — operator-accepted result when no verify command was configured.
 *   'verified' — external verify command exited 0 (strongest mechanical authority).
 *   'reviewed' — cross-model fresh-eyes review cleared the work.
 */

import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import {
  insertEvidenceRecord,
  getEvidenceForTarget,
  listEvidenceForLoop,
  deleteEvidenceForLoop,
  type EvidenceState,
  type EvidenceRecord,
} from '../persistence/rlm/rlm-evidence-records';

export type { EvidenceState, EvidenceRecord } from '../persistence/rlm/rlm-evidence-records';

const logger = getLogger('EvidenceStore');

// ---- Input types -----------------------------------------------------------

export interface RecordEvidenceParams {
  /** Loop run id (coordinator state.id). */
  loopId: string;
  /**
   * The claim / artefact being evidenced: typically a signal id
   * ('declared-complete', 'completed-rename', …) or a free-form target string.
   */
  target: string;
  /**
   * The evidence kind — a short machine-readable label such as 'verify-passed',
   * 'fresh-eyes-clean', 'operator-accepted', 'rename-gate', etc.
   */
  kind: string;
  /**
   * The authority level of this evidence record:
   *   'fixed'    — manually reviewed / no verify command present.
   *   'verified' — external verify command passed.
   *   'reviewed' — cross-model fresh-eyes review passed.
   */
  state: EvidenceState;
  /** Epoch ms when the evidence was gathered (defaults to Date.now()). */
  timestamp?: number;
  /** Optional source context to persist alongside the record. */
  sourceMetadata?: Record<string, unknown>;
}

// ---- EvidenceStore class ---------------------------------------------------

export class EvidenceStore {
  private static instance: EvidenceStore | null = null;

  constructor(private readonly db: SqliteDriver) {}

  // ---- Singleton -----------------------------------------------------------

  static getInstance(db: SqliteDriver): EvidenceStore {
    if (!EvidenceStore.instance) {
      EvidenceStore.instance = new EvidenceStore(db);
    }
    return EvidenceStore.instance;
  }

  /** Reset the singleton for test isolation. */
  static _resetForTesting(): void {
    EvidenceStore.instance = null;
  }

  // ---- Write ---------------------------------------------------------------

  /**
   * Durably record a piece of completion evidence.
   *
   * Fail-soft: any persistence error is logged and swallowed; the loop must
   * never fail because the evidence journal is unavailable.
   */
  record(params: RecordEvidenceParams): void {
    try {
      const now = Date.now();
      insertEvidenceRecord(this.db, {
        id: crypto.randomUUID(),
        loopId: params.loopId,
        target: params.target,
        kind: params.kind,
        state: params.state,
        timestamp: params.timestamp ?? now,
        sourceMetadata: params.sourceMetadata ?? {},
        createdAt: now,
      });
    } catch (err) {
      // Fail-soft: persistence errors must not break the loop hot path.
      logger.warn('EvidenceStore.record failed (fail-soft)', {
        loopId: params.loopId,
        target: params.target,
        state: params.state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- Read ----------------------------------------------------------------

  /**
   * Return all persisted evidence records for a specific target within a loop.
   * Optionally filtered to a single state.
   *
   * Returns empty array on error (fail-soft).
   */
  getForTarget(loopId: string, target: string, state?: EvidenceState): EvidenceRecord[] {
    try {
      return getEvidenceForTarget(this.db, loopId, target, state);
    } catch (err) {
      logger.warn('EvidenceStore.getForTarget failed (fail-soft)', {
        loopId,
        target,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Return all persisted evidence records for a loop, newest first.
   * Optionally filtered to a single state.
   *
   * Returns empty array on error (fail-soft).
   */
  listForLoop(loopId: string, state?: EvidenceState): EvidenceRecord[] {
    try {
      return listEvidenceForLoop(this.db, loopId, state);
    } catch (err) {
      logger.warn('EvidenceStore.listForLoop failed (fail-soft)', {
        loopId,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Remove all evidence records for a loop.  Call on loop teardown to keep
   * the table compact.  Fail-soft.
   */
  deleteForLoop(loopId: string): void {
    try {
      deleteEvidenceForLoop(this.db, loopId);
    } catch (err) {
      logger.warn('EvidenceStore.deleteForLoop failed (fail-soft)', {
        loopId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
