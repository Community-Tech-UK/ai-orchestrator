import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RendererPollSchedulerService } from './renderer-poll-scheduler.service';

describe('RendererPollSchedulerService', () => {
  let scheduler: RendererPollSchedulerService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    scheduler = new RendererPollSchedulerService();
  });

  afterEach(() => {
    scheduler.ngOnDestroy();
    vi.useRealTimers();
  });

  it('drives different cadences from one shared interval', async () => {
    const fast = vi.fn();
    const slow = vi.fn();
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');

    scheduler.register(fast, 1_000);
    scheduler.register(slow, 3_000);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('does not overlap an async task and stops after its last registration is removed', async () => {
    let release!: () => void;
    const task = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const unregister = scheduler.register(task, 1_000);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(1);

    release();
    await Promise.resolve();
    unregister();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
