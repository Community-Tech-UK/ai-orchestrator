import { describe, it, expect, vi } from 'vitest';
import {
  resumeThreadWithRetry,
  type ThreadResumeClient,
} from './thread-resume-retry';

function rpcTimeoutError(): Error {
  const err = new Error('RPC timeout: thread/resume did not respond within 60000ms');
  err.name = 'ProtocolError';
  return err;
}

function noRolloutError(): Error {
  // Deterministic server rejection — must NOT be retried.
  const err = new Error('thread/resume failed: no rollout found for thread id abc');
  err.name = 'ProtocolError';
  return err;
}

function closedError(): Error {
  const err = new Error('Connection closed');
  err.name = 'ProtocolError';
  return err;
}

const PARAMS = {
  threadId: 'thread-abc',
  cwd: '/tmp/project',
  model: null,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
} as Parameters<ThreadResumeClient['request']>[1];

describe('resumeThreadWithRetry', () => {
  const noSleep = () => Promise.resolve();

  it('returns the first successful result without retrying', async () => {
    const request = vi.fn().mockResolvedValue({ threadId: 'thread-abc' });
    const result = await resumeThreadWithRetry({ request }, PARAMS, { sleep: noSleep });
    expect(result).toEqual({ threadId: 'thread-abc' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries an RPC timeout and succeeds on a later attempt', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(rpcTimeoutError())
      .mockResolvedValueOnce({ threadId: 'thread-abc' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await resumeThreadWithRetry({ request }, PARAMS, { sleep });
    expect(result).toEqual({ threadId: 'thread-abc' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('follows the backoff schedule and throws after exhausting attempts', async () => {
    const request = vi.fn().mockRejectedValue(rpcTimeoutError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      resumeThreadWithRetry({ request }, PARAMS, { sleep }),
    ).rejects.toThrow(/RPC timeout/);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000]);
  });

  it('does NOT retry a deterministic "no rollout found" rejection', async () => {
    // This is the case that must fall straight through to the adapter's
    // recoverable handling (fresh + replay) unchanged.
    const request = vi.fn().mockRejectedValue(noRolloutError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      resumeThreadWithRetry({ request }, PARAMS, { sleep }),
    ).rejects.toThrow(/no rollout found/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry closed connections (same client cannot recover)', async () => {
    const request = vi.fn().mockRejectedValue(closedError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      resumeThreadWithRetry({ request }, PARAMS, { sleep }),
    ).rejects.toThrow(/Connection closed/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes the same method and params on every attempt', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(rpcTimeoutError())
      .mockResolvedValueOnce({ threadId: 'thread-abc' });

    await resumeThreadWithRetry({ request }, PARAMS, { sleep: noSleep });
    for (const call of request.mock.calls) {
      expect(call[0]).toBe('thread/resume');
      expect(call[1]).toBe(PARAMS);
    }
  });

  it('honors a custom attempt count, repeating the last delay', async () => {
    const request = vi.fn().mockRejectedValue(rpcTimeoutError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      resumeThreadWithRetry({ request }, PARAMS, { sleep, maxAttempts: 4 }),
    ).rejects.toThrow(/RPC timeout/);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000, 15_000]);
  });

  it('stops retrying when its caller aborts during the scheduled backoff', async () => {
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(rpcTimeoutError());
    const sleep = vi.fn(async () => {
      controller.abort(new Error('thread resume cancelled'));
    });

    await expect(resumeThreadWithRetry({ request }, PARAMS, {
      sleep,
      signal: controller.signal,
    })).rejects.toThrow('thread resume cancelled');

    expect(request).toHaveBeenCalledTimes(1);
  });
});
