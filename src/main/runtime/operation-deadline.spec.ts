import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withOperationDeadline, isDeadlineExceeded, DeadlineExceededError } from './operation-deadline';

describe('withOperationDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the operation result when it completes before the deadline', async () => {
    const result = await withOperationDeadline({
      name: 'test-op',
      deadlineMs: 5_000,
      operation: Promise.resolve(42),
    });
    expect(result).toBe(42);
  });

  it('rejects with the original error when the operation rejects before the deadline', async () => {
    const err = new Error('boom');
    await expect(withOperationDeadline({
      name: 'test-op',
      deadlineMs: 5_000,
      operation: Promise.reject(err),
    })).rejects.toThrow('boom');
  });

  it('throws DeadlineExceededError when the deadline elapses first', async () => {
    const neverResolves = new Promise<void>(() => undefined);
    const bounded = withOperationDeadline({
      name: 'test-op',
      deadlineMs: 1_000,
      operation: neverResolves,
    });
    vi.advanceTimersByTime(1_001);
    await expect(bounded).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('includes the operation name in the DeadlineExceededError message', async () => {
    const neverResolves = new Promise<void>(() => undefined);
    const bounded = withOperationDeadline({
      name: 'my-special-operation',
      deadlineMs: 500,
      operation: neverResolves,
    });
    vi.advanceTimersByTime(501);
    await expect(bounded).rejects.toThrow('my-special-operation');
  });

  it('calls onTimeout before throwing', async () => {
    const onTimeout = vi.fn();
    const neverResolves = new Promise<void>(() => undefined);
    const bounded = withOperationDeadline({
      name: 'test-op',
      deadlineMs: 500,
      operation: neverResolves,
      onTimeout,
    });
    vi.advanceTimersByTime(501);
    await expect(bounded).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(onTimeout).toHaveBeenCalledWith('test-op', undefined, 500);
  });

  it('accepts an operation factory function', async () => {
    const result = await withOperationDeadline({
      name: 'test-op',
      deadlineMs: 5_000,
      operation: () => Promise.resolve('factory'),
    });
    expect(result).toBe('factory');
  });
});

describe('isDeadlineExceeded', () => {
  it('returns true for DeadlineExceededError', () => {
    expect(isDeadlineExceeded(new DeadlineExceededError('test', 1000))).toBe(true);
  });

  it('returns false for ordinary errors', () => {
    expect(isDeadlineExceeded(new Error('ordinary'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isDeadlineExceeded('string')).toBe(false);
    expect(isDeadlineExceeded(null)).toBe(false);
    expect(isDeadlineExceeded(undefined)).toBe(false);
  });
});
