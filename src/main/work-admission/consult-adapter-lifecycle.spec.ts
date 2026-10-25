import { describe, expect, it, vi } from 'vitest';
import { pauseConsults } from './consult-admission';
import { trackConsultAdapter } from './consult-adapter-lifecycle';

describe('consult adapter teardown barrier', () => {
  it('retains a failed cleanup and retries it when Pause is attempted again', async () => {
    const cleanup = vi.fn().mockRejectedValue(new Error('Still running'));
    const interrupt = vi.fn();
    const finish = trackConsultAdapter({ interrupt }, cleanup);
    await expect(finish()).rejects.toThrow('Still running');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedAfterFailure = stopped;
    cleanup.mockResolvedValue(undefined);
    await pauseConsults(); await pausing;
    expect(stoppedAfterFailure).toBe(false);
    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(3);
    await pauseConsults();
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
});
