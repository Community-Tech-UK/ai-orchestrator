import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpStartupGate } from './acp-startup-gate';

describe('createAcpStartupGate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets one start through at a time, in order', async () => {
    const gate = createAcpStartupGate();
    const order: string[] = [];
    const releaseA = await gate();
    order.push('a-acquired');
    const pendingB = gate().then((release) => {
      order.push('b-acquired');
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual(['a-acquired']);
    releaseA();
    const releaseB = await pendingB;
    expect(order).toEqual(['a-acquired', 'b-acquired']);
    releaseB();
  });

  it('ignores a second release call', async () => {
    const gate = createAcpStartupGate();
    const release = await gate();
    release();
    release();
    const next = await gate();
    next();
  });

  it('releases a hung holder after the maximum hold time', async () => {
    vi.useFakeTimers();
    const gate = createAcpStartupGate(1_000);
    await gate();
    let acquired = false;
    const pending = gate().then((release) => {
      acquired = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(acquired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    (await pending)();
    expect(acquired).toBe(true);
  });
});
