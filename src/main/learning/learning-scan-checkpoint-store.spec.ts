import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import {
  LearningScanCheckpointStore,
  LEARNING_SCAN_GLOBAL_SCOPE,
  getLearningScanCheckpointStore,
} from './learning-scan-checkpoint-store';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function makeStore(db: SqliteDriver): LearningScanCheckpointStore {
  const store = getLearningScanCheckpointStore();
  store._bindDatabaseForTesting(db);
  return store;
}

describe('LearningScanCheckpointStore', () => {
  beforeEach(() => {
    LearningScanCheckpointStore._resetForTesting();
  });

  afterEach(() => {
    LearningScanCheckpointStore._resetForTesting();
    for (const db of dbs.splice(0)) db.close();
  });

  it('returns null for a scope that has never been scanned', () => {
    const store = makeStore(openMigratedDb());
    expect(store.get(LEARNING_SCAN_GLOBAL_SCOPE)).toBeNull();
  });

  it('recordRun persists a checkpoint readable via get()', () => {
    const store = makeStore(openMigratedDb());
    store.recordRun({
      scopeKey: '/repo',
      lastScannedEndedAt: 5000,
      lastScannedEntryId: 'e5',
      lastScanStartedAt: 100,
      lastScanCompletedAt: 200,
      sessionsScannedLastRun: 3,
      proposalsCreatedLastRun: 1,
      proposalsReinforcedLastRun: 2,
      lastError: null,
    });

    const checkpoint = store.get('/repo');
    expect(checkpoint).toMatchObject({
      scopeKey: '/repo',
      lastScannedEndedAt: 5000,
      lastScannedEntryId: 'e5',
      sessionsScannedLastRun: 3,
      sessionsScannedTotal: 3,
      proposalsCreatedLastRun: 1,
      proposalsReinforcedLastRun: 2,
      lastError: null,
    });
  });

  it('recordRun accumulates sessionsScannedTotal across runs, but last-run counters reflect only the latest run', () => {
    const store = makeStore(openMigratedDb());
    store.recordRun({
      scopeKey: '/repo', lastScannedEndedAt: 1000, lastScannedEntryId: 'e1',
      lastScanStartedAt: 1, lastScanCompletedAt: 2,
      sessionsScannedLastRun: 4, proposalsCreatedLastRun: 1, proposalsReinforcedLastRun: 0, lastError: null,
    });
    store.recordRun({
      scopeKey: '/repo', lastScannedEndedAt: 2000, lastScannedEntryId: 'e2',
      lastScanStartedAt: 3, lastScanCompletedAt: 4,
      sessionsScannedLastRun: 2, proposalsCreatedLastRun: 0, proposalsReinforcedLastRun: 1, lastError: null,
    });

    const checkpoint = store.get('/repo')!;
    expect(checkpoint.sessionsScannedLastRun).toBe(2);
    expect(checkpoint.sessionsScannedTotal).toBe(6);
    expect(checkpoint.lastScannedEndedAt).toBe(2000);
    expect(checkpoint.lastScannedEntryId).toBe('e2');
  });

  it('keeps separate checkpoints per scope key', () => {
    const store = makeStore(openMigratedDb());
    store.recordRun({
      scopeKey: '/repo-a', lastScannedEndedAt: 1000, lastScannedEntryId: 'a1',
      lastScanStartedAt: 1, lastScanCompletedAt: 2,
      sessionsScannedLastRun: 1, proposalsCreatedLastRun: 0, proposalsReinforcedLastRun: 0, lastError: null,
    });
    store.recordRun({
      scopeKey: '/repo-b', lastScannedEndedAt: 500, lastScannedEntryId: 'b1',
      lastScanStartedAt: 1, lastScanCompletedAt: 2,
      sessionsScannedLastRun: 1, proposalsCreatedLastRun: 0, proposalsReinforcedLastRun: 0, lastError: null,
    });

    expect(store.get('/repo-a')!.lastScannedEndedAt).toBe(1000);
    expect(store.get('/repo-b')!.lastScannedEndedAt).toBe(500);
  });

  it('is fail-soft when the database is unavailable', () => {
    const store = getLearningScanCheckpointStore();
    store._bindUnavailableForTesting();
    expect(store.get('/repo')).toBeNull();
    expect(() =>
      store.recordRun({
        scopeKey: '/repo', lastScannedEndedAt: 1, lastScannedEntryId: null,
        lastScanStartedAt: 1, lastScanCompletedAt: 2,
        sessionsScannedLastRun: 1, proposalsCreatedLastRun: 0, proposalsReinforcedLastRun: 0, lastError: null,
      }),
    ).not.toThrow();
  });
});
