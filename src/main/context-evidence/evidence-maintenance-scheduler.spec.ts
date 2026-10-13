import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvidenceMaintenanceScheduler } from './evidence-maintenance-scheduler';

describe('EvidenceMaintenanceScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('delays one sweep until five seconds after window readiness', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const maintain = vi.fn(async (_signal: AbortSignal) => pending);
    const scheduler = new EvidenceMaintenanceScheduler(maintain);
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(maintain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(maintain).toHaveBeenCalledOnce();
    scheduler.start();
    let stopped = false;
    const stop = scheduler.stop().then(() => { stopped = true; });
    expect(maintain.mock.calls[0]?.[0].aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintain).toHaveBeenCalledOnce();
  });

  it('never starts a cancelled scheduled generation', async () => {
    vi.useFakeTimers();
    const maintain = vi.fn(async () => undefined);
    const scheduler = new EvidenceMaintenanceScheduler(maintain);
    scheduler.start();
    await scheduler.stop();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maintain).not.toHaveBeenCalled();
  });
});
