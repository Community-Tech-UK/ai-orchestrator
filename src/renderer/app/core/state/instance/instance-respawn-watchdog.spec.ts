import { afterEach, describe, expect, it, vi } from 'vitest';

import { RespawnWatchdog } from './instance-respawn-watchdog';
import type { Instance } from './instance.types';

function recovering(waitReason?: Instance['waitReason']): Instance {
  return {
    id: 'inst-1',
    status: 'respawning',
    waitReason,
  } as Instance;
}

describe('RespawnWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not terminate a respawning instance waiting out a circuit-breaker backoff', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const inst = recovering({ kind: 'backoff', attempt: 4, retryAt: now + 30_000 });
    const terminateInstance = vi.fn().mockResolvedValue(undefined);
    const restartInstance = vi.fn().mockResolvedValue(undefined);
    const watchdog = new RespawnWatchdog(
      { getInstance: () => inst } as never,
      { terminateInstance, restartInstance } as never,
    );

    watchdog.update(inst.id, 'respawning');
    vi.advanceTimersByTime(15_000);

    expect(terminateInstance).not.toHaveBeenCalled();
    watchdog.clearAll();
  });

  it('still terminates a respawning instance that has no backoff wait', () => {
    vi.useFakeTimers();
    const inst = recovering();
    const terminateInstance = vi.fn().mockResolvedValue(undefined);
    const restartInstance = vi.fn().mockResolvedValue(undefined);
    const watchdog = new RespawnWatchdog(
      { getInstance: () => inst } as never,
      { terminateInstance, restartInstance } as never,
    );

    watchdog.update(inst.id, 'respawning');
    vi.advanceTimersByTime(15_000);

    expect(terminateInstance).toHaveBeenCalledWith(inst.id);
    watchdog.clearAll();
  });
});
