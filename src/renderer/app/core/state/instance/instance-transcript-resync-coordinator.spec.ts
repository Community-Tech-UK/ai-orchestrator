import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceStateService } from './instance-state.service';
import { InstanceTranscriptResync } from './instance-transcript-resync';

const identity = (instanceId = 'placeholder') => ({ kind: 'history-replay', instanceId,
  createdAt: 1, adapterGeneration: 1, restartEpoch: 0, revision: 1 });
afterEach(() => vi.useRealTimers());
describe('unknown-instance replay resync bounds', () => {
  it('coalesces chunks and expires identities with an observable failure while a request remains stalled', () => {
    vi.useFakeTimers();
    let retained: ReadonlyMap<string, number> | undefined;
    const load = vi.fn((ids: ReadonlyMap<string, number>) => {
      retained = ids;
      return new Promise<void>(() => undefined);
    });
    const failure = vi.fn();
    const coordinator = new InstanceTranscriptResync(new InstanceStateService(), load, failure);
    for (let index = 0; index < 100; index++) coordinator.request(identity());
    expect(load).toHaveBeenCalledTimes(1);
    expect(retained?.size).toBe(1);
    vi.advanceTimersByTime(30_001);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(retained?.size).toBe(0);
    coordinator.request(identity('another-placeholder'));
    expect(load).toHaveBeenCalledTimes(1);
    coordinator.clear();
  });

  it('bounds pending instance identities and reports overflow without starting extra requests', () => {
    let retained: ReadonlyMap<string, number> | undefined;
    const load = vi.fn((ids: ReadonlyMap<string, number>) => {
      retained = ids;
      return new Promise<void>(() => undefined);
    });
    const failure = vi.fn();
    const coordinator = new InstanceTranscriptResync(new InstanceStateService(), load, failure);
    for (let index = 0; index < 9; index++) coordinator.request(identity(`placeholder-${index}`));
    expect(failure).toHaveBeenCalledTimes(1);
    expect(retained?.size).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    coordinator.clear();
  });

  it('clears removal and teardown identities without reviving them or reporting a late failure', async () => {
    let resolve!: () => void;
    let retained: ReadonlyMap<string, number> | undefined;
    const failure = vi.fn();
    const coordinator = new InstanceTranscriptResync(new InstanceStateService(), ids => {
      retained = ids;
      return new Promise<void>(complete => { resolve = complete; });
    }, failure);
    coordinator.request(identity());
    coordinator.remove('placeholder');
    expect(retained?.size).toBe(0);
    coordinator.request(identity('second-placeholder'));
    coordinator.clear();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(retained?.size).toBe(0);
    expect(failure).not.toHaveBeenCalled();
  });
});
