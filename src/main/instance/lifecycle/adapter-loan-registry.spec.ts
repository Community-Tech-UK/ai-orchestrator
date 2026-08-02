import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  assertAdapterNotOnLoan,
  beginAdapterLoan,
  beginRuntimeChange,
  isRuntimeChangeInFlight,
  waitForRuntimeChange,
  endAdapterLoan,
  isAdapterOnLoan,
  loanHoldersFor,
  oldestLoanAgeMs,
  onAdapterLoanReleased,
  AdapterOnLoanError,
  _resetAdapterLoansForTesting,
} from './adapter-loan-registry';

describe('adapter-loan-registry (LT-020)', () => {
  beforeEach(() => {
    _resetAdapterLoansForTesting();
  });

  it('reports an instance as on loan between begin and end', () => {
    expect(isAdapterOnLoan('inst-1')).toBe(false);
    const loan = beginAdapterLoan('inst-1', 'loop-1');
    expect(isAdapterOnLoan('inst-1')).toBe(true);
    endAdapterLoan(loan);
    expect(isAdapterOnLoan('inst-1')).toBe(false);
  });

  it('keeps the instance on loan until the last holder releases', () => {
    const a = beginAdapterLoan('inst-1', 'loop-a');
    const b = beginAdapterLoan('inst-1', 'loop-b');
    expect(loanHoldersFor('inst-1')).toHaveLength(2);

    endAdapterLoan(a);
    expect(isAdapterOnLoan('inst-1')).toBe(true);

    endAdapterLoan(b);
    expect(isAdapterOnLoan('inst-1')).toBe(false);
  });

  /**
   * The child invoker can time out its own promise while the listener is still
   * awaiting the CLI, and the coordinator then retries the SAME loopRunId on the
   * same borrowed adapter. Keyed by loopRunId, the timed-out attempt's release
   * would free a loan the retry still needs — re-opening LT-020.
   */
  it('does not let one attempt release a concurrent retry of the same loop run', () => {
    const released: string[] = [];
    onAdapterLoanReleased((id) => released.push(id));

    const attempt = beginAdapterLoan('inst-1', 'loop-a');
    const retry = beginAdapterLoan('inst-1', 'loop-a');
    expect(attempt.token).not.toBe(retry.token);
    expect(loanHoldersFor('inst-1')).toHaveLength(2);

    endAdapterLoan(attempt);
    expect(isAdapterOnLoan('inst-1')).toBe(true);
    expect(released).toEqual([]);

    endAdapterLoan(retry);
    expect(isAdapterOnLoan('inst-1')).toBe(false);
    expect(released).toEqual(['inst-1']);
  });

  it('notifies listeners only when the final holder releases', () => {
    const seen: string[] = [];
    onAdapterLoanReleased((id) => seen.push(id));

    const a = beginAdapterLoan('inst-1', 'loop-a');
    const b = beginAdapterLoan('inst-1', 'loop-b');
    endAdapterLoan(a);
    expect(seen).toEqual([]);

    endAdapterLoan(b);
    expect(seen).toEqual(['inst-1']);
  });

  it('tolerates an undefined loan and a double release', () => {
    const seen: string[] = [];
    onAdapterLoanReleased((id) => seen.push(id));
    const loan = beginAdapterLoan('inst-1', 'loop-1');

    endAdapterLoan(undefined);
    endAdapterLoan(loan);
    endAdapterLoan(loan);

    expect(seen).toEqual(['inst-1']);
    expect(isAdapterOnLoan('inst-1')).toBe(false);
  });

  it('does not let a throwing listener break the release path', () => {
    const good = vi.fn();
    onAdapterLoanReleased(() => { throw new Error('boom'); });
    onAdapterLoanReleased(good);

    const loan = beginAdapterLoan('inst-1', 'loop-1');
    expect(() => endAdapterLoan(loan)).not.toThrow();
    expect(good).toHaveBeenCalledWith('inst-1');
    expect(isAdapterOnLoan('inst-1')).toBe(false);
  });

  it('unsubscribes a listener', () => {
    const seen: string[] = [];
    const off = onAdapterLoanReleased((id) => seen.push(id));
    off();

    endAdapterLoan(beginAdapterLoan('inst-1', 'loop-1'));
    expect(seen).toEqual([]);
  });

  it('assertAdapterNotOnLoan throws only when a live adapter is on loan', () => {
    beginAdapterLoan('inst-1', 'loop-a');

    // A dead adapter has nothing to SIGTERM, and blocking would strand a
    // failover on a broken provider.
    expect(() => assertAdapterNotOnLoan('inst-1', false)).not.toThrow();
    expect(() => assertAdapterNotOnLoan('inst-1', true)).toThrow(AdapterOnLoanError);
    expect(() => assertAdapterNotOnLoan('other', true)).not.toThrow();
  });

  it('tracks loan age and clears it on release', () => {
    expect(oldestLoanAgeMs('inst-1')).toBe(0);
    const loan = beginAdapterLoan('inst-1', 'loop-a');
    expect(oldestLoanAgeMs('inst-1')).toBeGreaterThanOrEqual(0);
    endAdapterLoan(loan);
    expect(oldestLoanAgeMs('inst-1')).toBe(0);
  });
});

/**
 * LT-030 — the reciprocal half of the interlock. The loan stops the reconciler
 * tearing down an adapter mid-iteration; this stops a loop taking the adapter
 * back while the reconciler is still delivering its post-change messages.
 * Without it a swap landed, the loop immediately started its next iteration on
 * the new adapter, and every notice the reconciler still had to send either hung
 * or was refused — so the swap was reverted and the user was told nothing.
 */
describe('runtime-change claim (LT-030)', () => {
  beforeEach(() => {
    _resetAdapterLoansForTesting();
  });

  it('reports a change in flight only between claim and release', () => {
    expect(isRuntimeChangeInFlight('inst-1')).toBe(false);
    const claim = beginRuntimeChange('inst-1');
    expect(isRuntimeChangeInFlight('inst-1')).toBe(true);
    expect(isRuntimeChangeInFlight('other')).toBe(false);
    claim.release();
    expect(isRuntimeChangeInFlight('inst-1')).toBe(false);
  });

  it('resolves immediately when nothing is in flight', async () => {
    await expect(waitForRuntimeChange('inst-1')).resolves.toBeUndefined();
  });

  it('blocks a waiter until the change is released', async () => {
    const claim = beginRuntimeChange('inst-1');
    let settled = false;
    const waiting = waitForRuntimeChange('inst-1').then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);

    claim.release();
    await waiting;
    expect(settled).toBe(true);
  });

  it('wakes every waiter on a single release', async () => {
    const claim = beginRuntimeChange('inst-1');
    const results: number[] = [];
    const all = Promise.all([
      waitForRuntimeChange('inst-1').then(() => results.push(1)),
      waitForRuntimeChange('inst-1').then(() => results.push(2)),
    ]);
    claim.release();
    await all;
    expect(results).toHaveLength(2);
  });

  it('is idempotent — a double release does not throw or re-wake', async () => {
    const claim = beginRuntimeChange('inst-1');
    claim.release();
    expect(() => claim.release()).not.toThrow();
    await expect(waitForRuntimeChange('inst-1')).resolves.toBeUndefined();
  });

  it('gives up after the timeout so a stuck reconciler cannot stall the loop', async () => {
    vi.useFakeTimers();
    beginRuntimeChange('inst-1');   // deliberately never released
    let settled = false;
    const waiting = waitForRuntimeChange('inst-1', 5_000).then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await waiting;
    expect(settled).toBe(true);
    vi.useRealTimers();
  });

  it('is independent of the loan — the two halves do not interfere', () => {
    const loan = beginAdapterLoan('inst-1', 'loop-a');
    const claim = beginRuntimeChange('inst-2');
    expect(isAdapterOnLoan('inst-1')).toBe(true);
    expect(isRuntimeChangeInFlight('inst-1')).toBe(false);
    expect(isAdapterOnLoan('inst-2')).toBe(false);
    expect(isRuntimeChangeInFlight('inst-2')).toBe(true);
    endAdapterLoan(loan);
    claim.release();
  });
});
