import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { GlobalPauseStore } from './global-pause-store';

describe('GlobalPauseStore', () => {
  let db: SqliteDriver;
  let store: GlobalPauseStore;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new GlobalPauseStore(db);
  });
  afterEach(() => db.close());

  it('allows only one open batch and recovers its saved hold', () => {
    const batch = store.createBatch('holding', 'Held by James', 10);
    expect(store.getOpenBatch()).toMatchObject({ id: batch.id, phase: 'holding', since: 10 });
    expect(() => store.createBatch('collecting', null, 20)).toThrow();
    store.finishBatch(batch.id, 'discarded', 30);
    expect(store.getOpenBatch()).toBeNull();
    expect(store.createBatch('collecting', null, 40).id).not.toBe(batch.id);
  });

  it('keeps one entry per target and deletes its note when it becomes void', () => {
    const batch = store.createBatch('collecting', null, 10);
    const entry = store.addEntry(batch.id, { kind: 'session', targetId: 's', displayName: 'Chat', wasBusy: true }, 11);
    store.setEntry(entry.id, { noteText: 'Next step', noteKind: 'agent', state: 'ready' }, 12);
    expect(store.addEntry(batch.id, { kind: 'session', targetId: 's', displayName: 'Chat', wasBusy: true }, 13).id).toBe(entry.id);
    store.voidTarget('s', 'picked-up-by-james', 14);
    expect(store.entries(batch.id)[0]).toMatchObject({ noteText: null, state: 'void', voidReason: 'picked-up-by-james' });
  });

  it('merges old runtime aliases into one refreshed actionable session', () => {
    const batch = store.createBatch('collecting', null, 1);
    const old = store.addEntry(batch.id, { kind: 'session', targetId: 'old', originalInstanceId: 'old', historyThreadId: 'thread', displayName: 'Old', wasBusy: true }, 2);
    store.addEntry(batch.id, { kind: 'session', targetId: 'new', historyThreadId: 'thread', displayName: 'New', wasBusy: true }, 3);
    const refreshed = store.refreshSnapshot(batch.id, { kind: 'session', targetId: 'new', historyThreadId: 'thread', displayName: 'Current', wasBusy: true }, 4);
    expect(refreshed).toMatchObject({ id: old.id, targetId: 'new', originalInstanceId: 'old', displayName: 'Current', state: 'pending' });
    expect(store.entries(batch.id)).toHaveLength(1);
  });
  it('keeps provider session identifiers separate across different providers', () => {
    const batch = store.createBatch('collecting', null);
    store.addEntry(batch.id, { kind: 'session', targetId: 'one', provider: 'codex', providerSessionId: 'shared', displayName: 'One', wasBusy: true });
    store.refreshSnapshot(batch.id, { kind: 'session', targetId: 'two', provider: 'claude', providerSessionId: 'shared', displayName: 'Two', wasBusy: true });
    expect(store.entries(batch.id)).toHaveLength(2);
  });
  it('clears notes on consumption and purges ended batches after thirty days', () => {
    const batch = store.createBatch('collecting', null, 10);
    const entry = store.addEntry(batch.id, { kind: 'session', targetId: 's', displayName: 'Chat', wasBusy: true });
    store.setEntry(entry.id, { noteText: 'Saved note', state: 'ready' });
    store.finishBatch(batch.id, 'resumed', 20);
    expect(store.entries(batch.id)[0].noteText).toBeNull();
    store.purgeEndedBefore(21);
    expect(store.entries(batch.id)).toEqual([]);
  });
});
