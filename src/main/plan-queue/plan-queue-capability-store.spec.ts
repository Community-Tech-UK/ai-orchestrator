import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueCapabilityGap } from '@contracts/schemas/plan-queue';
import { PlanQueueCapabilityStore } from './plan-queue-capability-store';
import { PlanQueueStore } from './plan-queue-store';
import { newPlanQueueItem } from './plan-queue-state';

let db: SqliteDriver;
let store: PlanQueueCapabilityStore;
const gap: PlanQueueCapabilityGap = {
  capabilityKey: 'disposable-session', check: 'Create a restricted test session', requiredAction: 'Create a test-owned restricted session',
  platform: 'macos', provider: 'codex', classification: 'capability',
  attempts: [{ operation: 'Discover test session controls', observedAt: 10, result: 'No isolated session control is exposed.' }],
  alternative: 'The production app cannot be controlled by this test.', expectedResult: 'The isolated session replies successfully.',
  implementation: 'Extend the existing owned test session interface, with scope tests and cleanup.',
};
beforeEach(() => {
  db = new Database(':memory:') as unknown as SqliteDriver; db.exec('PRAGMA foreign_keys = ON'); runLoopMigrations(db); store = new PlanQueueCapabilityStore(db, () => 100);
  const queue = new PlanQueueStore(db);
  for (const id of ['source', 'another']) queue.upsertRun({ id, parentInstanceId: 'owner', parentHistoryThreadId: null, kind: 'livetests', workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
    relaxation: null, workerProvider: 'codex', workerModel: null, startedAt: 1, endedAt: null });
  for (const id of ['first', 'second']) queue.upsertItem(newPlanQueueItem(id, 'source', `/repo/${id}_livetest.md`, 1));
});
afterEach(() => db.close());

describe('durable capability repair ownership', () => {
  const request = (itemId: string) => ({ repository: '/repo', sourceRunId: 'source', itemId, gap,
    config: DEFAULT_PLAN_QUEUE_CONFIG.plans, accountRules: { never: [], last: [] }, planDirectory: 'docs/plans', reportedBy: { instanceId: 'worker', role: 'worker' as const, round: 0, at: 10 } });
  it('attaches two checks to one repair and retains them across a fresh store', () => {
    const first = store.attach(request('first'));
    const second = store.attach(request('second'));
    expect(first.id).toBe(second.id);
    store = new PlanQueueCapabilityStore(db, () => 200);
    expect(store.origins(first.id).map(o => o.itemId)).toEqual(['first', 'second']);
    expect(store.get(first.id)?.gap).toEqual(gap);
  });
  it('retains retry intent across store recreation and finalizes all attached checks atomically', () => {
    const repair = store.attach(request('first'));
    store.attach({ ...request('first'), gap: { ...gap, check: 'Remove the restricted test session' } });
    expect(() => store.atomic(() => {
      store.recordRetryIntent(store.origins(repair.id)[0]!);
      throw new Error('interrupted while recording intent');
    })).toThrow('interrupted');
    expect(store.origins(repair.id).every(origin => !origin.retryIntent)).toBe(true);
    store.atomic(() => { for (const origin of store.origins(repair.id)) store.recordRetryIntent(origin); });
    store = new PlanQueueCapabilityStore(db, () => 200);
    expect(store.origins(repair.id).map(origin => [origin.state, origin.retryIntent])).toEqual([['waiting', true], ['waiting', true]]);
    expect(() => store.atomic(() => {
      store.setOriginState(store.origins(repair.id)[0]!, 'retrying');
      throw new Error('interrupted before the second check');
    })).toThrow('interrupted');
    expect(store.origins(repair.id).map(origin => origin.state)).toEqual(['waiting', 'waiting']);
    store.atomic(() => { for (const origin of store.origins(repair.id)) store.setOriginState(origin, 'retrying'); });
    expect(store.origins(repair.id).map(origin => origin.state)).toEqual(['retrying', 'retrying']);
  });
  it('does not revive an explicitly cancelled repair on a repeated report', () => {
    const first = store.attach(request('first'));
    store.save({ ...first, state: 'cancelled', detail: 'Cancelled by the owner.' });
    expect(store.attach(request('second'))).toMatchObject({ id: first.id, state: 'cancelled' });
  });
  it('separates platform and provider applicability', () => {
    const first = store.attach(request('first'));
    const second = store.attach({ ...request('second'), gap: { ...gap, platform: 'windows' } });
    expect(first.id).not.toBe(second.id);
  });
  it('preserves the first owner routing and generated plan path when another run attaches', () => {
    const first = store.attach(request('first'));
    const second = store.attach({ ...request('second'), sourceRunId: 'another' });
    expect(second.sourceRunId).toBe('source');
    expect(second.config.maxRounds).toBe(first.config.maxRounds);
    expect(second.planPath).toBe(first.planPath);
    expect(second.planPath).toMatch(/^\/repo\/docs\/plans\/capability-[a-f0-9-]+_plan\.md$/);
  });
  it('refuses coalescing a different account fence or a larger verification-round budget', () => {
    store.attach(request('first'));
    expect(() => store.attach({ ...request('second'), accountRules: { never: [{ provider: 'codex', accountId: 'blocked' }], last: [] } })).toThrow(/different account/);
    expect(() => store.attach({ ...request('second'), config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, maxRounds: 9 } })).toThrow(/different account/);
  });
  it('bounds stored checks per item while allowing an existing observation to be refreshed', () => {
    for (let n = 0; n < 32; n++) store.attach({ ...request('first'), gap: { ...gap, check: `Check ${n}` } });
    expect(() => store.attach({ ...request('first'), gap: { ...gap, check: 'One more check' } })).toThrow(/limit/);
    expect(() => store.attach({ ...request('first'), gap: { ...gap, check: 'Check 0' } })).not.toThrow();
  });
  it('enforces source ownership integrity through the real database foreign keys', () => {
    expect(() => store.attach({ ...request('first'), sourceRunId: 'missing' })).toThrow(/FOREIGN KEY/);
    expect(store.list()).toEqual([]);
  });
});
