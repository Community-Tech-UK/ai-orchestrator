import { describe, it, expect, vi } from 'vitest';
import {
  startThreadWithRetry,
  isTransientThreadStartError,
  isTransientRpcTimeoutError,
  type ThreadStartClient,
} from './thread-start-retry';

function rpcTimeoutError(): Error {
  const err = new Error('RPC timeout: thread/start did not respond within 60000ms');
  err.name = 'ProtocolError';
  return err;
}

function closedError(): Error {
  const err = new Error('Connection closed');
  err.name = 'ProtocolError';
  return err;
}

const PARAMS = {
  cwd: '/tmp/project',
  model: null,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  serviceName: 'harness',
  ephemeral: false,
  reasoningEffort: null,
  serviceTier: null,
} as Parameters<ThreadStartClient['request']>[1];

describe('isTransientThreadStartError', () => {
  it('matches ProtocolError RPC timeouts', () => {
    expect(isTransientThreadStartError(rpcTimeoutError())).toBe(true);
  });

  it('rejects closed connections (same client cannot recover)', () => {
    expect(isTransientThreadStartError(closedError())).toBe(false);
  });

  it('rejects non-ProtocolError errors and non-errors', () => {
    expect(isTransientThreadStartError(new Error('RPC timeout: whatever'))).toBe(false);
    expect(isTransientThreadStartError('RPC timeout')).toBe(false);
    expect(isTransientThreadStartError(undefined)).toBe(false);
  });

  it('is an alias of the shared isTransientRpcTimeoutError', () => {
    expect(isTransientRpcTimeoutError(rpcTimeoutError())).toBe(true);
    expect(isTransientRpcTimeoutError(closedError())).toBe(false);
  });
});

describe('startThreadWithRetry', () => {
  const noSleep = () => Promise.resolve();

  it('returns the first successful result without retrying', async () => {
    const request = vi.fn().mockResolvedValue({ threadId: 't1' });
    const result = await startThreadWithRetry({ request }, PARAMS, { sleep: noSleep });
    expect(result).toEqual({ threadId: 't1' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries an RPC timeout and succeeds on a later attempt', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(rpcTimeoutError())
      .mockResolvedValueOnce({ threadId: 't2' });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await startThreadWithRetry({ request }, PARAMS, { sleep });
    expect(result).toEqual({ threadId: 't2' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('follows the backoff schedule and throws after exhausting attempts', async () => {
    const request = vi.fn().mockRejectedValue(rpcTimeoutError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      startThreadWithRetry({ request }, PARAMS, { sleep }),
    ).rejects.toThrow(/RPC timeout/);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000]);
  });

  it('does not retry non-transient errors', async () => {
    const request = vi.fn().mockRejectedValue(closedError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      startThreadWithRetry({ request }, PARAMS, { sleep }),
    ).rejects.toThrow(/Connection closed/);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes the same method and params on every attempt', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(rpcTimeoutError())
      .mockResolvedValueOnce({ threadId: 't3' });

    await startThreadWithRetry({ request }, PARAMS, { sleep: noSleep });
    for (const call of request.mock.calls) {
      expect(call[0]).toBe('thread/start');
      expect(call[1]).toBe(PARAMS);
    }
  });

  it('honors a custom attempt count, repeating the last delay', async () => {
    const request = vi.fn().mockRejectedValue(rpcTimeoutError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      startThreadWithRetry({ request }, PARAMS, { sleep, maxAttempts: 4 }),
    ).rejects.toThrow(/RPC timeout/);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 15_000, 15_000]);
  });
});
