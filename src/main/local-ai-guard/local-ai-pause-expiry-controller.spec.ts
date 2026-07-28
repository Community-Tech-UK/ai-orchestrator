import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalAiTarget } from '../../shared/types/local-ai-guard.types';
import { LocalAiPauseExpiryController } from './local-ai-pause-expiry-controller';

const START = 10_000;

function pausedTarget(): LocalAiTarget {
  return {
    id: 'target-1',
    label: 'Local target',
    lifecycle: 'paused',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:8b', required: true }],
    canary: { model: 'qwen3:8b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
    createdAt: 1,
    updatedAt: 2,
    pausedUntil: START,
  };
}

describe('LocalAiPauseExpiryController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a transient persistence failure with backoff and transitions exactly once', async () => {
    let current = pausedTarget();
    const setLifecycle = vi.fn()
      .mockImplementationOnce(() => { throw new Error('database busy'); })
      .mockImplementation(() => {
        current = { ...current, lifecycle: 'enrolled' };
        delete current.pausedUntil;
        return current;
      });
    const transitioned = vi.fn();
    const controller = createController(() => current, setLifecycle, transitioned);

    controller.schedule(current);
    await vi.advanceTimersByTimeAsync(0);
    expect(setLifecycle).toHaveBeenCalledOnce();
    expect(transitioned).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(setLifecycle).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(setLifecycle).toHaveBeenCalledTimes(2);
    expect(transitioned).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(setLifecycle).toHaveBeenCalledTimes(2);
  });

  it('contains an initial target read failure and retries from a fresh exact-state read', async () => {
    let current = pausedTarget();
    const get = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sensitive database detail'); })
      .mockImplementation(() => current);
    const setLifecycle = vi.fn(() => {
      current = { ...current, lifecycle: 'enrolled' };
      delete current.pausedUntil;
      return current;
    });
    const transitioned = vi.fn();
    const warn = vi.fn();
    const controller = createController(get, setLifecycle, transitioned, warn);

    controller.schedule(current);
    await vi.advanceTimersByTimeAsync(0);

    expect(setLifecycle).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Local AI Guard timed pause could not resume',
      { reason: 'target-read-failed' },
    );
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setLifecycle).toHaveBeenCalledOnce();
    expect(transitioned).toHaveBeenCalledOnce();
  });

  it('contains a retry revalidation read failure and never resumes a changed deadline', async () => {
    let current = pausedTarget();
    const get = vi.fn()
      .mockImplementationOnce(() => current)
      .mockImplementationOnce(() => { throw new Error('sensitive database detail'); })
      .mockImplementation(() => current);
    const setLifecycle = vi.fn(() => { throw new Error('database busy'); });
    const warn = vi.fn();
    const controller = createController(get, setLifecycle, vi.fn(), warn);

    controller.schedule(current);
    await vi.advanceTimersByTimeAsync(0);

    expect(setLifecycle).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenLastCalledWith(
      'Local AI Guard timed pause could not resume',
      { reason: 'target-read-failed' },
    );
    expect(vi.getTimerCount()).toBe(1);

    current = { ...current, pausedUntil: START + 5_000 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setLifecycle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps persistent failures retryable at a bounded delay and stop cancels retries', async () => {
    const current = pausedTarget();
    const setLifecycle = vi.fn(() => { throw new Error('database unavailable'); });
    const controller = createController(() => current, setLifecycle, vi.fn());

    controller.schedule(current);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 16_000 + 32_000 + 60_000);
    expect(setLifecycle.mock.calls.length).toBeGreaterThan(5);
    expect(vi.getTimerCount()).toBe(1);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a read retry before a manual resume can receive a late mutation', async () => {
    let current = pausedTarget();
    const get = vi.fn()
      .mockImplementationOnce(() => { throw new Error('database unavailable'); })
      .mockImplementation(() => current);
    const setLifecycle = vi.fn();
    const controller = createController(get, setLifecycle, vi.fn());
    controller.schedule(current);
    await vi.advanceTimersByTimeAsync(0);

    current = { ...current, lifecycle: 'enrolled' };
    delete current.pausedUntil;
    controller.cancel(current.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(get).toHaveBeenCalledOnce();
    expect(setLifecycle).not.toHaveBeenCalled();
  });
});

function createController(
  get: () => LocalAiTarget | undefined,
  setLifecycle: ReturnType<typeof vi.fn>,
  onTransition: ReturnType<typeof vi.fn>,
  warn: ReturnType<typeof vi.fn> = vi.fn(),
): LocalAiPauseExpiryController {
  return new LocalAiPauseExpiryController(
    { get, setLifecycle } as never,
    {
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    () => Date.now(),
    () => 0,
    onTransition,
    { warn } as never,
  );
}
