/**
 * A4 — LoopCoordinator evidence-journal wiring.
 *
 * The pure resolver (evidence-resolver) and the durable store (evidence-store)
 * were both shipped and tested in isolation, but the coordinator never called
 * `EvidenceStore.record()` — the store was orphan code. These tests cover the
 * wiring added to the coordinator:
 *
 *   1. verify-passed attempt persists a distinct `verified` record.
 *   2. clean fresh-eyes attempt persists a distinct `reviewed` record.
 *   3. an attempt with both persists both, distinctly.
 *   4. a verify-failed attempt persists nothing.
 *   5. a verify-failed attempt AFTER a prior `verified` record raises a
 *      contradiction (regression) convergence note.
 *   6. fail-soft: with no store bound, journalling is a silent no-op.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { EvidenceStore } from './evidence-store';
import { LoopCoordinator } from './loop-coordinator';
import type { EvidenceResolution } from './evidence-resolver';
import type { CompletionSignalEvidence, LoopState } from '../../shared/types/loop.types';

// ---- Helpers ---------------------------------------------------------------

function createTestDb(): SqliteDriver {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_records (
      id               TEXT PRIMARY KEY,
      loop_id          TEXT NOT NULL,
      target           TEXT NOT NULL,
      kind             TEXT NOT NULL,
      state            TEXT NOT NULL CHECK(state IN ('fixed', 'verified', 'reviewed')),
      timestamp        INTEGER NOT NULL,
      source_metadata  TEXT NOT NULL DEFAULT '{}',
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_records_loop
      ON evidence_records(loop_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_evidence_records_target
      ON evidence_records(loop_id, target, state);
  `);
  return db;
}

const candidate: CompletionSignalEvidence = {
  id: 'declared-complete',
  sufficient: true,
  detail: 'agent declared complete',
};

function fakeState(id = 'loop-evidence-1'): LoopState {
  // recordCompletionEvidence only reads `id` and `completionAttempts`.
  return { id, completionAttempts: 1 } as unknown as LoopState;
}

function resolution(outcome: EvidenceResolution['outcome']): EvidenceResolution {
  return {
    decision: outcome === 'verify-failed' ? 'continue' : 'stop',
    authorityTier: 2,
    outcome,
    signalId: 'declared-complete',
    reason: '',
    needsReviewReason: null,
    convergenceNote: null,
  };
}

/** Typed view of the private members under test. */
interface CoordinatorInternals {
  recordCompletionEvidence(
    state: LoopState,
    candidate: CompletionSignalEvidence,
    ev: {
      verifyPassed: boolean;
      freshEyesRan: boolean;
      freshEyesBlockingCount: number;
      freshEyesErrored: boolean;
      resolution: EvidenceResolution;
    },
  ): void;
  convergenceNotes: Map<string, string>;
}

function internals(c: LoopCoordinator): CoordinatorInternals {
  return c as unknown as CoordinatorInternals;
}

// ---- Tests -----------------------------------------------------------------

describe('LoopCoordinator evidence journal (A4)', () => {
  let coordinator: LoopCoordinator;
  let db: SqliteDriver;
  let store: EvidenceStore;

  beforeEach(() => {
    EvidenceStore._resetForTesting();
    db = createTestDb();
    store = new EvidenceStore(db);
    coordinator = new LoopCoordinator();
    coordinator.setEvidenceStore(store);
  });

  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('persists a distinct `verified` record for a verify-passed attempt', () => {
    internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
      verifyPassed: true,
      freshEyesRan: false,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('accepted'),
    });

    const verified = store.getForTarget('loop-evidence-1', 'declared-complete', 'verified');
    expect(verified).toHaveLength(1);
    expect(verified[0]!.kind).toBe('verify-passed');
    expect(store.getForTarget('loop-evidence-1', 'declared-complete', 'reviewed')).toHaveLength(0);
  });

  it('persists a distinct `reviewed` record for a clean fresh-eyes attempt', () => {
    internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
      verifyPassed: false,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('accepted'),
    });

    const reviewed = store.getForTarget('loop-evidence-1', 'declared-complete', 'reviewed');
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]!.kind).toBe('fresh-eyes-clean');
    expect(store.getForTarget('loop-evidence-1', 'declared-complete', 'verified')).toHaveLength(0);
  });

  it('persists both states distinctly when verify passed AND fresh-eyes ran clean', () => {
    internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
      verifyPassed: true,
      freshEyesRan: true,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('accepted'),
    });

    expect(store.getForTarget('loop-evidence-1', 'declared-complete', 'verified')).toHaveLength(1);
    expect(store.getForTarget('loop-evidence-1', 'declared-complete', 'reviewed')).toHaveLength(1);
    expect(store.listForLoop('loop-evidence-1')).toHaveLength(2);
  });

  it('does NOT record a `reviewed` entry when fresh-eyes had a blocking finding', () => {
    internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
      verifyPassed: false,
      freshEyesRan: true,
      freshEyesBlockingCount: 1,
      freshEyesErrored: false,
      resolution: resolution('review-blocked'),
    });
    expect(store.listForLoop('loop-evidence-1')).toHaveLength(0);
  });

  it('persists nothing on a verify-failed attempt with no prior evidence', () => {
    internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
      verifyPassed: false,
      freshEyesRan: false,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('verify-failed'),
    });
    expect(store.listForLoop('loop-evidence-1')).toHaveLength(0);
    expect(internals(coordinator).convergenceNotes.get('loop-evidence-1')).toBeUndefined();
  });

  it('raises a contradiction note when verify fails after a prior verified pass', () => {
    const state = fakeState();
    // First: a passing attempt persists `verified`.
    internals(coordinator).recordCompletionEvidence(state, candidate, {
      verifyPassed: true,
      freshEyesRan: false,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('accepted'),
    });
    // Then: verify regresses on a later attempt.
    internals(coordinator).recordCompletionEvidence(state, candidate, {
      verifyPassed: false,
      freshEyesRan: false,
      freshEyesBlockingCount: 0,
      freshEyesErrored: false,
      resolution: resolution('verify-failed'),
    });

    const note = internals(coordinator).convergenceNotes.get('loop-evidence-1');
    expect(note).toBeTruthy();
    expect(note).toContain('verify regressed');
    // No positive record is written for the failed attempt.
    expect(store.getForTarget('loop-evidence-1', 'declared-complete', 'verified')).toHaveLength(1);
  });

  it('is a silent no-op when no evidence store is bound (fail-soft)', () => {
    coordinator.setEvidenceStore(null);
    expect(() =>
      internals(coordinator).recordCompletionEvidence(fakeState(), candidate, {
        verifyPassed: true,
        freshEyesRan: true,
        freshEyesBlockingCount: 0,
        freshEyesErrored: false,
        resolution: resolution('accepted'),
      }),
    ).not.toThrow();
    // Nothing persisted because the store was never consulted.
    expect(store.listForLoop('loop-evidence-1')).toHaveLength(0);
  });
});
