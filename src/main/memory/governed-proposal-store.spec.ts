import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { GovernedProposalStore, getGovernedProposalStore } from './governed-proposal-store';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function makeStore(db: SqliteDriver): GovernedProposalStore {
  const store = getGovernedProposalStore();
  store._bindDatabaseForTesting(db);
  return store;
}

describe('GovernedProposalStore', () => {
  beforeEach(() => {
    GovernedProposalStore._resetForTesting();
  });

  afterEach(() => {
    GovernedProposalStore._resetForTesting();
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates a proposal and writes a created audit row', () => {
    const store = makeStore(openMigratedDb());
    const result = store.capture({
      kind: 'memory',
      normalizedTitle: 'always run typecheck before claiming done',
      title: 'Always run typecheck before claiming done',
      provenance: 'agent-derived',
      payloadJson: JSON.stringify({ text: 'Always run typecheck before claiming done.' }),
      sourceSessionId: 'loop-run-1',
    });

    expect(result).not.toBeNull();
    expect(result!.reinforced).toBe(false);
    expect(result!.proposal.status).toBe('pending');
    expect(result!.proposal.kind).toBe('memory');
    expect(result!.proposal.sourceSessionId).toBe('loop-run-1');

    const audit = store.getAuditTrail(result!.proposal.id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('created');
  });

  it('reinforces (not duplicates) a pending proposal with the same normalized title', () => {
    const store = makeStore(openMigratedDb());
    const params = {
      kind: 'memory' as const,
      normalizedTitle: 'reuse the connection pool',
      title: 'Reuse the connection pool',
      provenance: 'agent-derived',
    };
    const first = store.capture(params);
    const second = store.capture(params);

    expect(first!.reinforced).toBe(false);
    expect(second!.reinforced).toBe(true);
    expect(second!.proposal.id).toBe(first!.proposal.id);
    expect(second!.proposal.reinforcements).toBe(2);

    const all = store.list({ kind: 'memory' });
    expect(all).toHaveLength(1);

    const audit = store.getAuditTrail(first!.proposal.id);
    expect(audit.map((a) => a.action)).toEqual(['created', 'reinforced']);
  });

  it('does not reinforce a non-pending proposal with the same title (creates a new one)', () => {
    const store = makeStore(openMigratedDb());
    const params = {
      kind: 'memory' as const,
      normalizedTitle: 'same title twice',
      title: 'Same title twice',
      provenance: 'agent-derived',
    };
    const first = store.capture(params);
    store.applyDecision(
      first!.proposal.id,
      { status: 'approved', decidedAt: Date.now(), decidedBy: 'james' },
      { action: 'approved', actor: 'james' },
    );

    const second = store.capture(params);
    expect(second!.reinforced).toBe(false);
    expect(second!.proposal.id).not.toBe(first!.proposal.id);
    expect(store.list({ kind: 'memory' })).toHaveLength(2);
  });

  it('lists proposals filtered by kind and status, newest first', () => {
    const store = makeStore(openMigratedDb());
    const p1 = store.capture({ kind: 'memory', normalizedTitle: 'a', title: 'A', provenance: 'agent-derived' })!;
    const p2 = store.capture({ kind: 'memory', normalizedTitle: 'b', title: 'B', provenance: 'agent-derived' })!;
    store.applyDecision(p1.proposal.id, { status: 'approved', decidedAt: Date.now() }, { action: 'approved' });

    expect(store.list({ kind: 'memory', status: 'pending' }).map((p) => p.id)).toEqual([p2.proposal.id]);
    expect(store.list({ kind: 'memory', status: 'approved' }).map((p) => p.id)).toEqual([p1.proposal.id]);
  });

  it('applyDecision updates status/payload and writes exactly one audit row', () => {
    const store = makeStore(openMigratedDb());
    const created = store.capture({ kind: 'memory', normalizedTitle: 'x', title: 'X', provenance: 'agent-derived' })!;

    const updated = store.applyDecision(
      created.proposal.id,
      { status: 'rejected', decidedAt: 123, decidedBy: 'james', decisionRationale: 'not generalizable' },
      { action: 'rejected', actor: 'james', reason: 'not generalizable' },
    );

    expect(updated!.status).toBe('rejected');
    expect(updated!.decidedBy).toBe('james');
    expect(updated!.decisionRationale).toBe('not generalizable');

    const audit = store.getAuditTrail(created.proposal.id);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({ action: 'rejected', actor: 'james', reason: 'not generalizable' });
  });

  it('hasEverRun reports whether a given audit action has ever been written', () => {
    const store = makeStore(openMigratedDb());
    expect(store.hasEverRun('backfilled')).toBe(false);
    const created = store.capture({ kind: 'memory', normalizedTitle: 'x', title: 'X', provenance: 'agent-derived' })!;
    store.writeAuditOnly(created.proposal.id, 'backfilled');
    expect(store.hasEverRun('backfilled')).toBe(true);
  });

  it('is fail-soft when the database is unavailable', () => {
    const store = getGovernedProposalStore();
    store._bindUnavailableForTesting();
    expect(store.capture({ kind: 'memory', normalizedTitle: 'x', title: 'X', provenance: 'agent-derived' })).toBeNull();
    expect(store.list()).toEqual([]);
    expect(store.get('missing')).toBeNull();
    expect(store.getAuditTrail('missing')).toEqual([]);
    expect(store.hasEverRun('backfilled')).toBe(false);
  });
});
