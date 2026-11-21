import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { ResolvedAccountRoute } from '../../shared/types/provider-account.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { _resetQuotaAutoRefreshForTesting } from '../core/system/provider-quota/quota-auto-refresh';
import { ProviderRuntimeService } from './provider-runtime-service';
import { ProviderRuntimeRegistry } from './provider-runtime-registry';

const quota = vi.hoisted(() => ({
  refresh: vi.fn(async () => undefined),
  getSnapshot: vi.fn((): ProviderQuotaSnapshot | null => null),
  ingestFromAdapter: vi.fn(),
}));
vi.mock('../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => quota,
  clearElapsedQuotaWindows: (snapshot: ProviderQuotaSnapshot) => snapshot,
}));

const route: ResolvedAccountRoute = {
  provider: 'claude', profileId: 'test-account', source: 'explicit', executionNodeId: 'local',
};

function createRuntime(accountRoute?: ResolvedAccountRoute) {
  const adapter = Object.assign(new EventEmitter(), { getRuntimeCapabilities: () => undefined });
  const runtime = new ProviderRuntimeService({
    registry: new ProviderRuntimeRegistry(),
    createAdapter: () => adapter as unknown as CliAdapter,
  });
  runtime.createAdapter({ cliType: 'claude', options: { accountRoute } });
  return adapter;
}

describe('ordinary Claude runtime quota lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T15:00:00Z'));
    vi.clearAllMocks();
    quota.getSnapshot.mockReturnValue(null);
    _resetQuotaAutoRefreshForTesting();
  });
  afterEach(() => vi.useRealTimers());

  it('refreshes the routed account on spawn and completion', () => {
    const adapter = createRuntime(route);
    adapter.emit('spawned', 123);
    adapter.emit('complete');
    expect(quota.refresh.mock.calls).toEqual([
      ['claude', 'test-account'], ['claude', 'test-account'],
    ]);
    expect(quota.getSnapshot).toHaveBeenCalledWith('claude', 'test-account');
  });

  it('refreshes the default endpoint when no account route exists', () => {
    const adapter = createRuntime();
    adapter.emit('complete');
    expect(quota.refresh).toHaveBeenCalledExactlyOnceWith('claude', null);
  });

  it('skips fresh header snapshots, then refreshes at ten minutes', () => {
    const adapter = createRuntime(route);
    quota.getSnapshot.mockReturnValue({ provider: 'claude', ok: true, source: 'header', takenAt: Date.now(), windows: [] });
    adapter.emit('complete');
    expect(quota.refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600_000);
    adapter.emit('complete');
    expect(quota.refresh).toHaveBeenCalledExactlyOnceWith('claude', 'test-account');
  });

  it('keeps endpoint observations on the debounced refresh path', () => {
    const adapter = createRuntime(route);
    quota.getSnapshot.mockReturnValue({ provider: 'claude', ok: true, source: 'admin-api', takenAt: Date.now(), windows: [] });
    adapter.emit('complete');
    adapter.emit('complete');
    expect(quota.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    adapter.emit('complete');
    expect(quota.refresh).toHaveBeenCalledTimes(2);
  });

  it('debounces independently for different accounts', () => {
    const first = createRuntime(route);
    const second = createRuntime({ ...route, profileId: 'other-test-account' });
    first.emit('complete');
    second.emit('complete');
    expect(quota.refresh.mock.calls).toEqual([
      ['claude', 'test-account'], ['claude', 'other-test-account'],
    ]);
  });

  it('detaches on exit and attaches a single hook to a replacement', () => {
    const old = createRuntime(route);
    old.emit('complete');
    old.emit('exit', 0, null);
    expect(old.listenerCount('spawned')).toBe(0);
    expect(old.listenerCount('complete')).toBe(0);
    expect(old.listenerCount('exit')).toBe(0);
    vi.advanceTimersByTime(60_000);
    const replacement = createRuntime(route);
    old.emit('spawned', 123);
    old.emit('complete');
    expect(quota.refresh).toHaveBeenCalledTimes(1);
    replacement.emit('complete');
    expect(quota.refresh).toHaveBeenCalledTimes(2);
    expect(replacement.listenerCount('complete')).toBe(1);
  });
});
