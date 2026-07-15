import { describe, expect, it, vi } from 'vitest';

import { recoverFromInputCap, type InputCapRecoveryOps } from './input-cap-recovery';

const CAP_ERROR = new Error('Input exceeds the maximum length of 1048576 characters');

function makeOps(overrides: Partial<InputCapRecoveryOps> = {}): InputCapRecoveryOps {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(true),
    reopenThread: vi.fn().mockResolvedValue(undefined),
    onThreadReset: vi.fn(),
    ...overrides,
  };
}

describe('recoverFromInputCap', () => {
  it('rung 1: compacts, waits, and the post-compaction retry succeeds — no thread reset', async () => {
    // The initial (failing) send happened in the caller; the ladder's first
    // send() is already the post-compaction retry.
    const send = vi.fn().mockResolvedValue(undefined);
    const ops = makeOps({ send });

    await recoverFromInputCap(ops);

    expect(ops.compact).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1); // post-compaction retry only
    expect(ops.reopenThread).not.toHaveBeenCalled();
    expect(ops.onThreadReset).not.toHaveBeenCalled();
  });

  it('rung 2: reopens a fresh thread when the post-compaction retry still overflows', async () => {
    const send = vi.fn().mockRejectedValueOnce(CAP_ERROR).mockResolvedValueOnce(undefined);
    const ops = makeOps({ send });

    await recoverFromInputCap(ops);

    expect(ops.reopenThread).toHaveBeenCalledTimes(1);
    expect(ops.onThreadReset).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2); // post-compaction (fails) + post-reopen (ok)
  });

  it('rung 2: reopens without retrying the old thread when compaction is unavailable or unobserved', async () => {
    const ops = makeOps({ compact: vi.fn().mockResolvedValue(false), send: vi.fn().mockResolvedValue(undefined) });

    await recoverFromInputCap(ops);

    expect(ops.reopenThread).toHaveBeenCalledTimes(1);
    expect(ops.send).toHaveBeenCalledTimes(1); // only the post-reopen send
  });

  it('rung 3: throws a clear error when even a fresh thread overflows', async () => {
    const ops = makeOps({ send: vi.fn().mockRejectedValue(CAP_ERROR) });

    await expect(recoverFromInputCap(ops)).rejects.toThrow(/your message exceeds/i);
    expect(ops.reopenThread).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-cap error from the post-compaction retry without reopening', async () => {
    const boom = new Error('http 500 internal server error');
    const ops = makeOps({ send: vi.fn().mockRejectedValue(boom) });

    await expect(recoverFromInputCap(ops)).rejects.toThrow(/http 500/i);
    expect(ops.reopenThread).not.toHaveBeenCalled();
  });

  it('propagates a non-cap error from the fresh-thread send unchanged', async () => {
    const boom = new Error('app-server crashed');
    const ops = makeOps({ compact: vi.fn().mockResolvedValue(false), send: vi.fn().mockRejectedValue(boom) });

    await expect(recoverFromInputCap(ops)).rejects.toThrow(/app-server crashed/i);
    expect(ops.onThreadReset).toHaveBeenCalledTimes(1);
  });
});
