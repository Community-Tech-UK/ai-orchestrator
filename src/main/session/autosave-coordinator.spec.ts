import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAutoSaveCoordinator } from './autosave-coordinator';

describe('SessionAutoSaveCoordinator', () => {
  let dirty: Set<string>;
  let locked: Set<string>;
  let now: number;
  let saveState: ReturnType<typeof vi.fn>;
  let onSaveError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    dirty = new Set<string>();
    locked = new Set<string>();
    now = 1_000;
    saveState = vi.fn().mockResolvedValue(undefined);
    onSaveError = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createCoordinator(): SessionAutoSaveCoordinator {
    return new SessionAutoSaveCoordinator({
      getDirtyIds: () => dirty,
      hasDirty: (instanceId) => dirty.has(instanceId),
      isLocked: (instanceId) => locked.has(instanceId),
      saveState,
      onSaveError,
      getNow: () => now,
      getJitterDelayMs: () => 0,
    });
  }

  it('deduplicates pending auto-save timers per instance', async () => {
    dirty.add('instance-1');
    const autoSave = createCoordinator();

    autoSave.queueAutoSave('instance-1', 10);
    autoSave.queueAutoSave('instance-1', 10);

    await vi.advanceTimersByTimeAsync(10);

    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith('instance-1');
  });

  it('defers a queued save until the resume grace period expires', async () => {
    dirty.add('instance-1');
    const autoSave = createCoordinator();

    const deferredUntil = autoSave.defer(100);
    autoSave.queueAutoSave('instance-1', 0);

    await vi.advanceTimersByTimeAsync(0);
    expect(deferredUntil).toBe(1_100);
    expect(saveState).not.toHaveBeenCalled();
    expect(autoSave.pendingCount).toBe(1);

    now = 1_100;
    await vi.advanceTimersByTimeAsync(100);

    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith('instance-1');
  });

  it('periodically schedules dirty unlocked states', async () => {
    dirty.add('instance-1');
    dirty.add('locked-instance');
    locked.add('locked-instance');
    const autoSave = createCoordinator();

    autoSave.start({
      autoSaveEnabled: true,
      autoSaveIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(51);
    autoSave.stop();

    expect(saveState).toHaveBeenCalledOnce();
    expect(saveState).toHaveBeenCalledWith('instance-1');
  });

  it('routes save errors through the injected handler', async () => {
    dirty.add('instance-1');
    const error = new Error('disk full');
    saveState.mockRejectedValueOnce(error);
    const autoSave = createCoordinator();

    autoSave.queueAutoSave('instance-1', 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSaveError).toHaveBeenCalledWith('instance-1', error);
  });
});
