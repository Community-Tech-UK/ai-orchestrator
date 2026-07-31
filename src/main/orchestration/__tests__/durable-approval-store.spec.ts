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

  // WS-B3: adjudicator attribution + extra audit detail.
  it('resolve() records resolvedBy="adjudicator" and merges extraDetail into the audit log', () => {
    store.create({
      approvalId: 'adjudicated-1',
      instanceId: 'inst-1',
      actionKind: 'deferred_permission',
      payload: { toolName: 'Bash', resource: 'bash:ls' },
      expiresAt: Date.now() + 60_000,
    });

    const resolved = store.resolve('adjudicated-1', 'approved', 'adjudicator', {
      model: 'approvalAdjudication',
      riskLevel: 'low',
      reason: 'Read-only listing, low risk.',
    });
    expect(resolved?.status).toBe('approved');
    expect(resolved?.resolvedBy).toBe('adjudicator');

    const auditRows = db
      .prepare('SELECT event, detail_json FROM approval_audit_log WHERE approval_id = ? ORDER BY id')
      .all('adjudicated-1') as { event: string; detail_json: string | null }[];
    const resolvedRow = auditRows.find((r) => r.event === 'approved');
    expect(resolvedRow).toBeDefined();
    const detail = JSON.parse(resolvedRow!.detail_json!);
    expect(detail).toMatchObject({
      resolvedBy: 'adjudicator',
      model: 'approvalAdjudication',
      riskLevel: 'low',
      reason: 'Read-only listing, low risk.',
    });
  });

  describe('getInstance() singleton', () => {
    beforeEach(() => {
      DurableApprovalStore._resetForTesting();
    });

    it('returns the same instance for the same process and is independent of a directly-constructed store', () => {
      const db2 = new Database(':memory:') as unknown as SqliteDriver;
      const shared1 = DurableApprovalStore.getInstance(db2);
      const shared2 = DurableApprovalStore.getInstance(db2);
      expect(shared1).toBe(shared2);
    });

    it('_resetForTesting() clears the singleton so the next getInstance() constructs fresh', () => {
      const db2 = new Database(':memory:') as unknown as SqliteDriver;
      const first = DurableApprovalStore.getInstance(db2);
      DurableApprovalStore._resetForTesting();
      const second = DurableApprovalStore.getInstance(db2);
      expect(second).not.toBe(first);
    });
  });
});
