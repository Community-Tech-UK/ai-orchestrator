import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InstanceCreateIdempotencyCache,
  _resetInstanceCreateIdempotencyCacheForTesting,
  getInstanceCreateIdempotencyCache,
} from './instance-create-idempotency';
import type { IpcResponse } from '../../../shared/types/ipc.types';

const ok = (id: string): IpcResponse => ({ success: true, data: { id } });
const fail = (message: string): IpcResponse => ({
  success: false,
  error: { code: 'CREATE_WITH_MESSAGE_FAILED', message, timestamp: 0 },
});

describe('InstanceCreateIdempotencyCache', () => {
  beforeEach(() => {
    _resetInstanceCreateIdempotencyCacheForTesting();
  });

  it('runs the first delivery', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    const run = vi.fn().mockResolvedValue(ok('inst-1'));

    await expect(cache.run('k', run)).resolves.toEqual(ok('inst-1'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('replays the original response instead of creating a second session', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    const run = vi.fn().mockResolvedValue(ok('inst-1'));

    const first = await cache.run('k', run);
    const retry = await cache.run('k', run);

    // A retry after a slow acknowledgement must return the SAME instance —
    // returning nothing would leave the renderer without a usable id, and
    // running again would spawn a duplicate session.
    expect(retry).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serves a concurrent duplicate from the in-flight promise', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    let release: ((value: IpcResponse) => void) | undefined;
    const run = vi.fn().mockReturnValue(new Promise<IpcResponse>((resolve) => {
      release = resolve;
    }));

    const a = cache.run('k', run);
    const b = cache.run('k', run);
    release?.(ok('inst-1'));

    expect(await a).toEqual(await b);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('lets a genuine retry through after a failed create', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    const run = vi
      .fn()
      .mockResolvedValueOnce(fail('spawn failed'))
      .mockResolvedValueOnce(ok('inst-2'));

    await expect(cache.run('k', run)).resolves.toEqual(fail('spawn failed'));
    await expect(cache.run('k', run)).resolves.toEqual(ok('inst-2'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('lets a genuine retry through after a thrown create', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok('inst-3'));

    await expect(cache.run('k', run)).rejects.toThrow('boom');
    await expect(cache.run('k', run)).resolves.toEqual(ok('inst-3'));
  });

  it('expires entries past the TTL', async () => {
    let now = 1_000;
    const cache = new InstanceCreateIdempotencyCache(500, () => now);
    const run = vi.fn().mockResolvedValue(ok('inst-1'));

    await cache.run('k', run);
    expect(cache.has('k')).toBe(true);

    now += 501;
    expect(cache.has('k')).toBe(false);
    await cache.run('k', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keys are independent', async () => {
    const cache = new InstanceCreateIdempotencyCache();
    const run = vi.fn().mockResolvedValueOnce(ok('a')).mockResolvedValueOnce(ok('b'));

    await expect(cache.run('k1', run)).resolves.toEqual(ok('a'));
    await expect(cache.run('k2', run)).resolves.toEqual(ok('b'));
  });

  it('exposes a resettable singleton', () => {
    const first = getInstanceCreateIdempotencyCache();
    expect(getInstanceCreateIdempotencyCache()).toBe(first);

    _resetInstanceCreateIdempotencyCacheForTesting();
    expect(getInstanceCreateIdempotencyCache()).not.toBe(first);
  });
});
