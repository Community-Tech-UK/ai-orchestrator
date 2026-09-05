import { describe, expect, it, vi } from 'vitest';
import { probePidLiveness, waitOnPid, type PidLiveness } from './loop-wait-on-pid';

function killThrowing(code: string) {
  return () => { throw Object.assign(new Error(code), { code }); };
}

describe('probePidLiveness (L5)', () => {
  it('reports alive when the signal-0 probe succeeds', () => {
    expect(probePidLiveness(123, () => undefined)).toBe('alive');
  });

  it('reports gone on ESRCH', () => {
    expect(probePidLiveness(123, killThrowing('ESRCH'))).toBe('gone');
  });

  // EPERM means the process EXISTS and belongs to someone else. Reading it as
  // "gone" would release a wait on a process that is very much running.
  it('reports alive on EPERM — another user owns a running process', () => {
    expect(probePidLiveness(123, killThrowing('EPERM'))).toBe('alive');
  });

  it('reports unknown for an unusable pid rather than guessing', () => {
    expect(probePidLiveness(null)).toBe('unknown');
    expect(probePidLiveness(undefined)).toBe('unknown');
    expect(probePidLiveness(0)).toBe('unknown');
    expect(probePidLiveness(-1)).toBe('unknown');
    expect(probePidLiveness(1.5)).toBe('unknown');
  });

  it('reports unknown for an unexpected error code', () => {
    expect(probePidLiveness(123, killThrowing('EWEIRD'))).toBe('unknown');
  });
});

describe('waitOnPid (L5)', () => {
  function harness(sequence: readonly PidLiveness[]) {
    let clock = 0;
    let index = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    const probe = vi.fn(() => sequence[Math.min(index++, sequence.length - 1)]!);
    return { sleep, probe, now: () => clock };
  }

  it('returns immediately when the process has already exited', async () => {
    const h = harness(['gone']);
    const result = await waitOnPid({ pid: 1, timeoutMs: 10_000, ...h });

    expect(result.outcome).toBe('skipped');
    expect(h.sleep).not.toHaveBeenCalled();
    expect(result.reason).toContain('already exited');
  });

  // A wait primitive that can block on bad input is worse than none.
  it('fails open on an unusable pid instead of blocking', async () => {
    const h = harness(['unknown']);
    const result = await waitOnPid({ pid: null, timeoutMs: 10_000, ...h });

    expect(result.outcome).toBe('skipped');
    expect(h.sleep).not.toHaveBeenCalled();
    expect(result.reason).toContain('continuing rather than blocking');
  });

  it('waits until the process exits and reports how long it waited', async () => {
    const h = harness(['alive', 'alive', 'gone']);
    const result = await waitOnPid({ pid: 1, timeoutMs: 10_000, pollIntervalMs: 100, ...h });

    expect(result.outcome).toBe('exited');
    expect(result.waitedMs).toBe(200);
  });

  it('releases at the timeout so a wedged subprocess cannot hold the loop', async () => {
    const h = harness(['alive']);
    const result = await waitOnPid({ pid: 1, timeoutMs: 250, pollIntervalMs: 100, ...h });

    expect(result.outcome).toBe('timeout');
    expect(result.waitedMs).toBeGreaterThanOrEqual(250);
    expect(result.reason).toContain('still alive');
  });

  // A probe that stops answering mid-wait has not told us the process exited.
  it('fails open rather than claiming an exit when the probe stops answering', async () => {
    const h = harness(['alive', 'unknown']);
    const result = await waitOnPid({ pid: 1, timeoutMs: 10_000, pollIntervalMs: 100, ...h });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('stopped answering');
  });

  it('honours cancellation', async () => {
    const h = harness(['alive', 'alive']);
    let cancelled = false;
    const result = await waitOnPid({
      pid: 1,
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      ...h,
      isCancelled: () => {
        const value = cancelled;
        cancelled = true;
        return value;
      },
    });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('wait cancelled');
  });
});
