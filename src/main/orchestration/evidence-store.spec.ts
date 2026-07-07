/**
 * Tests for EvidenceStore — durable persistence + state distinctions (A4).
 *
 * Covers:
 *   1. Records persist and reload (round-trip via in-memory SQLite).
 *   2. fixed / verified / reviewed stored and queried distinctly.
 *   3. Persistence failure is fail-soft (no throw, empty results).
 *   4. Existing resolver behaviour is unchanged (resolveCompletion is still pure).
 *   5. getForTarget and listForLoop filtering by state.
 *   6. deleteForLoop removes only the targeted loop's records.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { EvidenceStore } from './evidence-store';
import type { EvidenceState } from './evidence-store';
import { resolveCompletion, type EvidenceInput } from './evidence-resolver';

// ---- Helpers ---------------------------------------------------------------

/**
 * Create an in-memory SQLite database with the evidence_records schema applied.
 * This exercises the same DDL as migration 035 without needing the full RLM stack.
 */
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

/** Minimal baseline EvidenceInput for resolveCompletion tests. */
function baseInput(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    signals: [],
    candidate: undefined,
    quickVerifyStatus: 'skipped',
    verifyStatus: 'passed',
    verifyLabel: 'verify',
    beltAndBracesPassed: true,
    freshEyesRan: false,
    freshEyesBlockingCount: 0,
    freshEyesErrored: false,
    manualReviewOnly: false,
    allowOperatorReviewedCompletion: false,
    completionAttempts: 0,
    maxCompletionAttempts: 3,
    finalAuditMode: 'observe',
    finalAuditStatus: 'passed',
    finalAuditFindings: [],
    ...over,
  };
}

// ---- Tests -----------------------------------------------------------------

describe('EvidenceStore — persistence round-trip', () => {
  let db: SqliteDriver;
  let store: EvidenceStore;

  beforeEach(() => {
    EvidenceStore._resetForTesting();
    db = createTestDb();
    store = new EvidenceStore(db);
  });

  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('records and reloads a single verified evidence entry', () => {
    store.record({
      loopId: 'loop-1',
      target: 'declared-complete',
      kind: 'verify-passed',
      state: 'verified',
      sourceMetadata: { verifyLabel: 'verify', exitCode: 0 },
    });

    const records = store.listForLoop('loop-1');
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.loopId).toBe('loop-1');
    expect(r.target).toBe('declared-complete');
    expect(r.kind).toBe('verify-passed');
    expect(r.state).toBe('verified');
    expect(r.sourceMetadata).toEqual({ verifyLabel: 'verify', exitCode: 0 });
    expect(r.timestamp).toBeGreaterThan(0);
    expect(r.createdAt).toBeGreaterThan(0);
  });

  it('records persist across a new EvidenceStore instance on the same db', () => {
    store.record({
      loopId: 'loop-2',
      target: 'completed-rename',
      kind: 'verify-passed',
      state: 'verified',
    });

    // Simulate restart: new EvidenceStore instance, same underlying db.
    EvidenceStore._resetForTesting();
    const store2 = new EvidenceStore(db);
    const records = store2.listForLoop('loop-2');
    expect(records).toHaveLength(1);
    expect(records[0]!.state).toBe('verified');
  });
});

describe('EvidenceStore — fixed / verified / reviewed as distinct states', () => {
  let db: SqliteDriver;
  let store: EvidenceStore;

  beforeEach(() => {
    EvidenceStore._resetForTesting();
    db = createTestDb();
    store = new EvidenceStore(db);
  });

  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('stores and queries fixed, verified, and reviewed separately for the same target', () => {
    const loopId = 'loop-states';
    const target = 'declared-complete';

    store.record({ loopId, target, kind: 'operator-accepted', state: 'fixed' });
    store.record({ loopId, target, kind: 'verify-passed', state: 'verified' });
    store.record({ loopId, target, kind: 'fresh-eyes-clean', state: 'reviewed' });

    const all = store.getForTarget(loopId, target);
    expect(all).toHaveLength(3);

    const fixedOnly = store.getForTarget(loopId, target, 'fixed');
    expect(fixedOnly).toHaveLength(1);
    expect(fixedOnly[0]!.kind).toBe('operator-accepted');

    const verifiedOnly = store.getForTarget(loopId, target, 'verified');
    expect(verifiedOnly).toHaveLength(1);
    expect(verifiedOnly[0]!.kind).toBe('verify-passed');

    const reviewedOnly = store.getForTarget(loopId, target, 'reviewed');
    expect(reviewedOnly).toHaveLength(1);
    expect(reviewedOnly[0]!.kind).toBe('fresh-eyes-clean');
  });

  it('listForLoop with state filter returns only matching state', () => {
    const loopId = 'loop-filter';

    store.record({ loopId, target: 't1', kind: 'verify-passed', state: 'verified' });
    store.record({ loopId, target: 't2', kind: 'fresh-eyes-clean', state: 'reviewed' });
    store.record({ loopId, target: 't3', kind: 'operator-accepted', state: 'fixed' });

    const verifiedRecords = store.listForLoop(loopId, 'verified');
    expect(verifiedRecords.every((r) => r.state === 'verified')).toBe(true);
    expect(verifiedRecords).toHaveLength(1);

    const reviewedRecords = store.listForLoop(loopId, 'reviewed');
    expect(reviewedRecords.every((r) => r.state === 'reviewed')).toBe(true);

    const fixedRecords = store.listForLoop(loopId, 'fixed');
    expect(fixedRecords.every((r) => r.state === 'fixed')).toBe(true);
  });

  it('three states can co-exist for different targets in the same loop', () => {
    const loopId = 'loop-multi';
    store.record({ loopId, target: 'signal-a', kind: 'verify-passed', state: 'verified' });
    store.record({ loopId, target: 'signal-b', kind: 'fresh-eyes-clean', state: 'reviewed' });
    store.record({ loopId, target: 'signal-c', kind: 'operator-accepted', state: 'fixed' });

    const all = store.listForLoop(loopId);
    const states = new Set<EvidenceState>(all.map((r) => r.state));
    expect(states.has('fixed')).toBe(true);
    expect(states.has('verified')).toBe(true);
    expect(states.has('reviewed')).toBe(true);
  });
});

describe('EvidenceStore — fail-soft on persistence errors', () => {
  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('record() does not throw when the db is closed / broken', () => {
    EvidenceStore._resetForTesting();
    const db = createTestDb();
    // Drop the table to simulate schema unavailability.
    db.exec('DROP TABLE evidence_records');

    const store = new EvidenceStore(db);
    // Must not throw.
    expect(() =>
      store.record({ loopId: 'x', target: 't', kind: 'k', state: 'verified' }),
    ).not.toThrow();
  });

  it('getForTarget() returns empty array when the db is broken', () => {
    EvidenceStore._resetForTesting();
    const db = createTestDb();
    db.exec('DROP TABLE evidence_records');

    const store = new EvidenceStore(db);
    const result = store.getForTarget('x', 't');
    expect(result).toEqual([]);
  });

  it('listForLoop() returns empty array when the db is broken', () => {
    EvidenceStore._resetForTesting();
    const db = createTestDb();
    db.exec('DROP TABLE evidence_records');

    const store = new EvidenceStore(db);
    const result = store.listForLoop('x');
    expect(result).toEqual([]);
  });

  it('deleteForLoop() does not throw when the db is broken', () => {
    EvidenceStore._resetForTesting();
    const db = createTestDb();
    db.exec('DROP TABLE evidence_records');

    const store = new EvidenceStore(db);
    expect(() => store.deleteForLoop('x')).not.toThrow();
  });
});

describe('EvidenceStore — deleteForLoop', () => {
  let db: SqliteDriver;
  let store: EvidenceStore;

  beforeEach(() => {
    EvidenceStore._resetForTesting();
    db = createTestDb();
    store = new EvidenceStore(db);
  });

  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('removes only the targeted loop while leaving others intact', () => {
    store.record({ loopId: 'loop-a', target: 't', kind: 'k', state: 'verified' });
    store.record({ loopId: 'loop-b', target: 't', kind: 'k', state: 'reviewed' });

    store.deleteForLoop('loop-a');

    expect(store.listForLoop('loop-a')).toHaveLength(0);
    expect(store.listForLoop('loop-b')).toHaveLength(1);
  });
});

describe('EvidenceStore — singleton', () => {
  afterEach(() => {
    EvidenceStore._resetForTesting();
  });

  it('returns the same instance for the same db', () => {
    const db = createTestDb();
    const s1 = EvidenceStore.getInstance(db);
    const s2 = EvidenceStore.getInstance(db);
    expect(s1).toBe(s2);
  });

  it('returns a fresh instance after _resetForTesting', () => {
    const db = createTestDb();
    const s1 = EvidenceStore.getInstance(db);
    EvidenceStore._resetForTesting();
    const s2 = EvidenceStore.getInstance(db);
    expect(s1).not.toBe(s2);
  });
});

// ---- Behaviour preservation: resolveCompletion is still pure ---------------

describe('resolveCompletion — behaviour preserved after A4 changes', () => {
  it('still returns stop/accepted when all gates pass (no side-effects introduced)', () => {
    const input = baseInput({
      candidate: { id: 'declared-complete', sufficient: true, detail: 'intent' },
      verifyStatus: 'passed',
      beltAndBracesPassed: true,
    });
    const r = resolveCompletion(input);
    expect(r.decision).toBe('stop');
    expect(r.outcome).toBe('accepted');
    expect(r.authorityTier).toBe(2);
  });

  it('still returns continue/verify-failed when verify fails', () => {
    const r = resolveCompletion(baseInput({
      candidate: { id: 'completed-rename', sufficient: true, detail: 'renamed' },
      verifyStatus: 'failed',
    }));
    expect(r.decision).toBe('continue');
    expect(r.outcome).toBe('verify-failed');
  });

  it('still returns pause-operator-review when verify is skipped with no review', () => {
    const r = resolveCompletion(baseInput({
      candidate: { id: 'done-sentinel', sufficient: true, detail: 'DONE.txt' },
      verifyStatus: 'skipped',
      manualReviewOnly: true,
    }));
    expect(r.decision).toBe('pause-operator-review');
    expect(r.outcome).toBe('unverifiable');
  });

  it('still returns stop-needs-review when rename budget is exhausted', () => {
    const r = resolveCompletion(baseInput({
      candidate: { id: 'completed-rename', sufficient: true, detail: 'renamed' },
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      completionAttempts: 3,
      maxCompletionAttempts: 3,
    }));
    expect(r.decision).toBe('stop-needs-review');
    expect(r.outcome).toBe('rename-gate');
  });
});
