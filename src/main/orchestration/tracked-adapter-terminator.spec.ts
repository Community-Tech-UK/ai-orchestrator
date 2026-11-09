import { describe, expect, it, vi } from 'vitest';
import { createTrackedAdapterTerminator } from './tracked-adapter-terminator';

describe('createTrackedAdapterTerminator', () => {
  it('shares one teardown between concurrent graceful callers', async () => {
    const terminate = vi.fn(async () => undefined);
    const stop = createTrackedAdapterTerminator(terminate);
    const adapter = {};
    await Promise.all([stop(adapter, false), stop(adapter, true), stop(adapter, false)]);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('runs again once the earlier teardown has settled', async () => {
    const terminate = vi.fn(async () => undefined);
    const stop = createTrackedAdapterTerminator(terminate);
    const adapter = {};
    await stop(adapter, false);
    await stop(adapter, false);
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it('does not let a slow graceful teardown swallow a later forced one', async () => {
    let release!: () => void;
    const terminate = vi.fn((_a: unknown, graceful: boolean) =>
      graceful ? new Promise<void>((r) => { release = r; }) : Promise.resolve());
    const stop = createTrackedAdapterTerminator(terminate);
    const adapter = {};
    const graceful = stop(adapter, true);
    await stop(adapter, false);
    expect(terminate).toHaveBeenCalledWith(adapter, false);
    release();
    await graceful;
  });

  it('chains a fresh pass after an in-flight teardown when asked', async () => {
    let release!: () => void;
    const terminate = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((r) => { release = r; }))
      .mockResolvedValue(undefined);
    const stop = createTrackedAdapterTerminator(terminate);
    const adapter = {};
    const first = stop(adapter, false);
    const own = stop(adapter, false, true);
    await Promise.resolve();
    expect(terminate).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, own]);
    expect(terminate).toHaveBeenCalledTimes(2);
  });

  it('stops waiting for a teardown that never settles and runs its own pass', async () => {
    const terminate = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(() => undefined))
      .mockResolvedValue(undefined);
    const stop = createTrackedAdapterTerminator(terminate, 20);
    const adapter = {};
    void stop(adapter, true);
    await stop(adapter, false, true);
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenLastCalledWith(adapter, false);
  });
});
