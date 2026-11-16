import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import type { ContextUsage } from '../../shared/types/instance.types';
import {
  PreSleepContext,
  setPreSleepContext,
  type PreSleepDeps,
  type PreSleepInstanceView,
} from '../context/pre-sleep-context';
import {
  compactWorkerBeforeSetAside,
  parkReasonLeavesIdleWorker,
  SET_ASIDE_ASSUMED_SLEEP_MS,
} from './plan-queue-set-aside-compaction';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const NOW = 1_000_000_000;
const big: ContextUsage = { used: 260_000, total: 1_000_000, percentage: 26, occupancyReported: true };

function install(patch: Partial<PreSleepInstanceView> = {}, deps: Partial<PreSleepDeps> = {}) {
  const instance: PreSleepInstanceView = {
    provider: 'claude', status: 'idle', contextUsage: big, executionLocation: { type: 'local' }, ...patch,
  };
  const compact = vi.fn(async () => true);
  const service = new PreSleepContext({
    getInstance: () => instance,
    getCacheLifetimeMs: () => null,
    hasPendingWork: () => false,
    compact,
    now: () => NOW,
    ...deps,
  });
  setPreSleepContext(service);
  return { instance, compact, service };
}

const run = (reason: PlanQueueParkReason, id: string | null = 'w1') => {
  const untrack = vi.fn();
  return { untrack, done: compactWorkerBeforeSetAside(id, reason, { untrack, now: () => NOW }) };
};

describe('compactWorkerBeforeSetAside', () => {
  afterEach(() => setPreSleepContext(null));

  it('treats a set-aside job as a sleep far longer than any cache lifetime', () => {
    expect(SET_ASIDE_ASSUMED_SLEEP_MS).toBeGreaterThan(60 * 60_000);
  });

  it('compacts a large idle Claude worker after a finished round, and stops the queue watching it first', async () => {
    const { compact } = install();
    const order: string[] = [];
    compact.mockImplementation(async () => { order.push('compact'); return true; });
    const untrack = vi.fn(() => { order.push('untrack'); });
    await compactWorkerBeforeSetAside('w1', 'round-limit', { untrack, now: () => NOW });
    expect(compact).toHaveBeenCalledWith('w1');
    expect(order).toEqual(['untrack', 'compact']);
  });

  it.each<PlanQueueParkReason>(['round-limit', 'stuck-on-same-finding', 'verifier-unreliable', 'no-diverse-verifier', 'needs-setup', 'needs-james'])(
    'handles %s', async (reason) => {
      const { compact } = install();
      await run(reason).done;
      expect(compact).toHaveBeenCalledTimes(1);
    });

  it.each<PlanQueueParkReason>(['cancelled', 'provider-limit', 'stopped-by-harness', 'worker-error', 'worktree-error', 'restart-loop', 'merge-conflict', 'land-blocked', 'check-hung', 'missing-document', 'triage-failed'])(
    'never delays or touches a stop for %s', async (reason) => {
      const { compact } = install();
      const { untrack, done } = run(reason);
      await done;
      expect(compact).not.toHaveBeenCalled();
      expect(untrack).not.toHaveBeenCalled();
      expect(parkReasonLeavesIdleWorker(reason)).toBe(false);
    });

  it('does nothing without a worker, or before the service is set up', async () => {
    const { compact } = install();
    await run('round-limit', null).done;
    expect(compact).not.toHaveBeenCalled();
    setPreSleepContext(null);
    await expect(run('round-limit').done).resolves.toBeUndefined();
  });

  it('leaves a small session, another provider and a busy worker alone, and keeps no request for a busy one', async () => {
    const small = install({ contextUsage: { ...big, used: 50_000, percentage: 5 } });
    await run('round-limit').done;
    expect(small.compact).not.toHaveBeenCalled();

    const other = install({ provider: 'codex' });
    await run('round-limit').done;
    expect(other.compact).not.toHaveBeenCalled();

    const busy = install({ status: 'busy' });
    await run('round-limit').done;
    busy.instance.status = 'idle';
    await expect(busy.service.onIdle('w1')).resolves.toBeNull();
    expect(busy.compact).not.toHaveBeenCalled();
  });

  it('does not wait on a worker with background work pending', async () => {
    const { compact } = install({}, { hasPendingWork: () => true });
    await run('needs-james').done;
    expect(compact).not.toHaveBeenCalled();
  });

  it('never throws: a compaction that fails or a service that errors cannot stop the park', async () => {
    const throwing = vi.fn(async (): Promise<boolean> => { throw new Error('boom'); });
    install({}, { compact: throwing });
    await expect(run('round-limit').done).resolves.toBeUndefined();
    expect(throwing).toHaveBeenCalled();

    install({}, { getInstance: () => { throw new Error('lookup failed'); } });
    await expect(run('round-limit').done).resolves.toBeUndefined();
  });
});
