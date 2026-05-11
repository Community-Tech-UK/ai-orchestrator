import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { DurableApprovalStore } from '../durable-approval-store';

describe('DurableApprovalStore', () => {
  let db: SqliteDriver;
  let store: DurableApprovalStore;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    store = new DurableApprovalStore(db);
  });

  it('persists a pending approval and reads it back', () => {
    const rec = store.create({
      approvalId: 'app-1',
      instanceId: 'inst-1',
      actionKind: 'shell',
      payload: { command: 'rm -rf /' },
      expiresAt: Date.now() + 60_000,
    });
    expect(rec.status).toBe('pending');

    const fetched = store.get('app-1');
    expect(fetched).toBeDefined();
    expect(fetched!.payload).toEqual({ command: 'rm -rf /' });
  });

  it('resolves approvals and rejects double-resolution', () => {
    store.create({
      approvalId: 'app-2',
      instanceId: 'inst-1',
      actionKind: 'write',
      payload: { path: 'a.txt' },
      expiresAt: Date.now() + 60_000,
    });
    const resolved = store.resolve('app-2', 'approved', 'user');
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolvedBy).toBe('user');

    const again = store.resolve('app-2', 'denied', 'user');
    expect(again).toBeUndefined(); // already resolved
  });

  it('listPending() filters out expired and resolved entries', () => {
    const now = Date.now();
    store.create({
      approvalId: 'live',
      instanceId: 'i1',
      actionKind: 'tool',
      payload: {},
      expiresAt: now + 60_000,
    });
    store.create({
      approvalId: 'expired',
      instanceId: 'i1',
      actionKind: 'tool',
      payload: {},
      expiresAt: now - 1, // already expired
    });
    store.create({
      approvalId: 'resolved',
      instanceId: 'i1',
      actionKind: 'tool',
      payload: {},
      expiresAt: now + 60_000,
    });
    store.resolve('resolved', 'approved', 'user');

    const pending = store.listPending('i1');
    expect(pending.map((r) => r.approvalId)).toEqual(['live']);
  });

  it('sweepExpired transitions stale pending entries to expired', () => {
    const past = Date.now() - 1000;
    store.create({
      approvalId: 'old',
      instanceId: 'i1',
      actionKind: 'tool',
      payload: {},
      expiresAt: past,
    });
    const swept = store.sweepExpired();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = store.get('old');
    expect(after?.status).toBe('expired');
  });
});
