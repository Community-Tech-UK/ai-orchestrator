import { describe, expect, it, vi, afterEach } from 'vitest';
import { pauseConsults, trackConsult } from './consult-admission';

describe('restart pause for anonymous reviews', () => {
  afterEach(() => vi.useRealTimers());
  it('interrupts running consults and waits for their teardown', async () => {
    let stop!: () => void;
    const interrupt = vi.fn(() => stop());
    stop = trackConsult(interrupt);
    await pauseConsults();
    expect(interrupt).toHaveBeenCalledOnce();
    await pauseConsults();
    expect(interrupt).toHaveBeenCalledOnce();
  });
  it('refuses to declare safety when an interrupted review never settles', async () => {
    vi.useFakeTimers();
    const stop = trackConsult(vi.fn());
    const pending = pauseConsults();
    const expectation = expect(pending).rejects.toThrow('still stopping');
    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    stop();
  });
});
