import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsage } from '../../shared/types/instance.types';
import {
  PreSleepContext,
  RECOMPACT_GUARD_MS,
  type PreSleepDeps,
  type PreSleepInstanceView,
} from './pre-sleep-context';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const MIN = 60_000;
const NOW = 1_000_000_000;
const big: ContextUsage = { used: 260_000, total: 1_000_000, percentage: 26, occupancyReported: true };

function setup(patch: Partial<PreSleepInstanceView> = {}, deps: Partial<PreSleepDeps> = {}) {
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
  return { instance, compact, service };
}

const wakeIn = (minutes: number, instanceId = 'i1', claimKey = 'a1') => ({
  instanceId, wakeAt: NOW + minutes * MIN, source: 'scheduled-wakeup' as const, claimKey,
});

describe('PreSleepContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('compacts an idle, large Claude session that will sleep past its cache lifetime', async () => {
    const { service, compact } = setup();
    await expect(service.note(wakeIn(180))).resolves.toEqual({ kind: 'compacted' });
    expect(compact).toHaveBeenCalledWith('i1');
  });

  it('uses the measured cache lifetime', async () => {
    const short = setup({}, { getCacheLifetimeMs: () => 5 * MIN });
    await expect(short.service.note(wakeIn(30))).resolves.toEqual({ kind: 'compacted' });
    const long = setup({}, { getCacheLifetimeMs: () => 120 * MIN });
    await expect(long.service.note(wakeIn(90))).resolves.toMatchObject({ kind: 'skipped' });
  });

  it('does not compact for a distant wake-up when another schedule wakes the session soon', async () => {
    const { service, compact } = setup();
    await service.note(wakeIn(20, 'i1', 'soon'));
    await expect(service.note(wakeIn(180, 'i1', 'later'))).resolves.toMatchObject({ kind: 'skipped' });
    expect(compact).not.toHaveBeenCalled();
    service.revokeClaim('soon');
    await expect(service.onIdle('i1')).resolves.toEqual({ kind: 'compacted' });
  });

  it('keeps an earlier short wake-up while a busy session waits to go idle', async () => {
    const { service, compact, instance } = setup({ status: 'busy' });
    await service.note(wakeIn(180, 'i1', 'later'));
    await service.note(wakeIn(20, 'i1', 'soon'));
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toMatchObject({ kind: 'skipped' });
    expect(compact).not.toHaveBeenCalled();
  });

  it.each([
    ['a short sleep', {}, 30],
    ['a small session', { contextUsage: { ...big, used: 150_000 } }, 180],
    ['an unreported size', { contextUsage: { ...big, occupancyReported: false } }, 180],
    ['a spend total instead of a window reading', { contextUsage: { ...big, occupancyIsAggregate: true } }, 180],
    ['another provider', { provider: 'codex' }, 180],
    ['a remote session', { executionLocation: { type: 'remote' } }, 180],
    ['a hibernated session', { status: 'hibernated' }, 180],
    ['a session parked on a quota', { waitReason: { kind: 'quota-park' } }, 180],
  ])('does nothing for %s', async (_name, patch, minutes) => {
    const { service, compact } = setup(patch as Partial<PreSleepInstanceView>);
    await expect(service.note(wakeIn(minutes))).resolves.toMatchObject({ kind: 'skipped' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('leaves a session alone while background work or a Claude wake-up lives in its process', async () => {
    const { service, compact } = setup({}, { hasPendingWork: () => true });
    await expect(service.note(wakeIn(180))).resolves.toMatchObject({ kind: 'skipped' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('waits for a busy session to go idle, then compacts once', async () => {
    const { service, compact, instance } = setup({ status: 'busy' });
    await expect(service.note(wakeIn(180))).resolves.toMatchObject({ kind: 'deferred' });
    expect(compact).not.toHaveBeenCalled();

    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toEqual({ kind: 'compacted' });
    await expect(service.onIdle('i1')).resolves.toBeNull(); // nothing left waiting
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting request once its wake-up has passed', async () => {
    let now = NOW;
    const { service, compact, instance } = setup({ status: 'busy' }, { now: () => now });
    await service.note({ instanceId: 'i1', wakeAt: NOW + 180 * MIN, source: 'scheduled-wakeup', claimKey: 'a1' });
    now = NOW + 200 * MIN;
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toMatchObject({ kind: 'skipped' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not compact the same session twice inside the guard window', async () => {
    let now = NOW;
    const { service, compact } = setup({}, { now: () => now });
    await service.note(wakeIn(180));
    now = NOW + RECOMPACT_GUARD_MS - 1;
    await expect(service.note({ instanceId: 'i1', wakeAt: now + 180 * MIN, source: 'scheduled-wakeup', claimKey: 'a1' }))
      .resolves.toMatchObject({ kind: 'skipped', reason: 'compacted a moment ago' });
    now = NOW + RECOMPACT_GUARD_MS;
    await expect(service.note({ instanceId: 'i1', wakeAt: now + 180 * MIN, source: 'scheduled-wakeup', claimKey: 'a1' }))
      .resolves.toEqual({ kind: 'compacted' });
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it('runs one compaction at a time per session', async () => {
    let release!: () => void;
    const gate = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const { service, compact } = setup({}, { compact: vi.fn(() => gate) });
    const first = service.note(wakeIn(180));
    const second = await service.note(wakeIn(240));
    expect(second).toMatchObject({ kind: 'skipped', reason: 'a compaction is already running' });
    release();
    await expect(first).resolves.toEqual({ kind: 'compacted' });
    expect(compact).not.toHaveBeenCalled(); // the injected spy replaced the default one
  });

  it('reports a failed or throwing compaction without throwing itself', async () => {
    const failing = setup({}, { compact: vi.fn(async () => false) });
    await expect(failing.service.note(wakeIn(180))).resolves.toMatchObject({ kind: 'failed' });
    const throwing = setup({}, { compact: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(throwing.service.note(wakeIn(180))).resolves.toEqual({ kind: 'failed', reason: 'boom' });
  });

  it('drops a deferred request when its claim is revoked', async () => {
    const { service, compact, instance } = setup({ status: 'busy' });
    await expect(service.note(wakeIn(180))).resolves.toMatchObject({ kind: 'deferred' });
    service.revokeClaim('a1');
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toBeNull();
    expect(compact).not.toHaveBeenCalled();
  });

  it('keeps another claim when one schedule is revoked', async () => {
    const { service, compact, instance } = setup({ status: 'busy' });
    await service.note(wakeIn(180, 'i1', 'a1'));
    await service.note(wakeIn(240, 'i1', 'a2'));
    service.revokeClaim('a1');
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toEqual({ kind: 'compacted' });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('moves a claim to another session when the same schedule is re-noted there', async () => {
    const instance = { provider: 'claude', status: 'busy', contextUsage: big, executionLocation: { type: 'local' } };
    const other = { ...instance };
    const compact = vi.fn(async () => true);
    const service = new PreSleepContext({
      getInstance: (id) => (id === 'i1' ? instance : id === 'i2' ? other : undefined),
      getCacheLifetimeMs: () => null,
      hasPendingWork: () => false,
      compact,
      now: () => NOW,
    });
    await service.note(wakeIn(180, 'i1', 'a1'));
    await service.note(wakeIn(180, 'i2', 'a1'));
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toBeNull();
    other.status = 'idle';
    await expect(service.onIdle('i2')).resolves.toEqual({ kind: 'compacted' });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith('i2');
  });

  it('replaces one schedule claim instead of keeping its old wake time', async () => {
    let now = NOW;
    const { service, compact, instance } = setup({ status: 'busy' }, { now: () => now });
    await service.note(wakeIn(180));
    await service.note(wakeIn(480, 'i1', 'a1'));
    now = NOW + 180 * MIN;
    instance.status = 'idle';
    // The schedule moved eight hours out, so the session still has a long sleep
    // ahead of it: the stale three-hour claim (whose sleep had already passed)
    // would have been ignored instead.
    await expect(service.onIdle('i1')).resolves.toEqual({ kind: 'compacted' });
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('forgets a session that was closed', async () => {
    const { service, instance } = setup({ status: 'busy' });
    await service.note(wakeIn(180));
    service.forget('i1');
    instance.status = 'idle';
    await expect(service.onIdle('i1')).resolves.toBeNull();
  });
});
