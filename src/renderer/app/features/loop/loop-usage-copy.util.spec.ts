import { describe, expect, it } from 'vitest';
import {
  activeCostUsage,
  activeTokenUsage,
  currentIterationLabel,
  isUsageUnsettled,
} from './loop-usage-copy.util';

describe('isUsageUnsettled', () => {
  it('treats a live iteration or a running status as unsettled', () => {
    expect(isUsageUnsettled(true, 'running')).toBe(true);
    // The reload-mid-iteration case: the push was missed, the run is still live.
    expect(isUsageUnsettled(false, 'running')).toBe(true);
  });

  it('treats every non-running status as settled', () => {
    for (const status of ['paused', 'provider-limit', 'completed', 'completed-needs-review', 'failed', 'cap-reached']) {
      expect(isUsageUnsettled(false, status)).toBe(false);
    }
    expect(isUsageUnsettled(false, undefined)).toBe(false);
  });
});

describe('currentIterationLabel', () => {
  it('renders real elapsed time only when an iteration is known to be running', () => {
    expect(currentIterationLabel(true, 90_000, true)).toBe('1m30s');
  });

  it('never renders a fabricated 0s for an unsettled turn of unknown age', () => {
    expect(currentIterationLabel(false, 0, true)).toBe('pending');
  });

  it('keeps idle formatting when the run is not running', () => {
    expect(currentIterationLabel(false, 0, false)).toBe('idle');
  });

  // L4: "pending" during a ten-minute test run reads as "nothing is happening".
  it('names the inferred phase instead of a bare pending', () => {
    expect(currentIterationLabel(false, 0, true, 'verifying')).toBe('running checks');
    expect(currentIterationLabel(true, 90_000, true, 'editing')).toBe('1m30s · editing');
  });

  it('never lets a phase override the not-running case', () => {
    expect(currentIterationLabel(false, 0, false, 'editing')).toBe('idle');
  });
});

describe('activeTokenUsage / activeCostUsage', () => {
  it('says pending rather than zero for a first unsettled iteration', () => {
    expect(activeTokenUsage(0, true)).toBe('tokens pending');
    expect(activeCostUsage(0, true)).toBe('cost pending');
  });

  it('splits settled totals from the unsettled current turn', () => {
    expect(activeTokenUsage(2_000, true)).toBe('2.0k tok settled + current pending');
    expect(activeCostUsage(5, true)).toBe('$0.05 settled + current pending');
  });

  it('renders plain totals once nothing is in flight', () => {
    expect(activeTokenUsage(2_000, false)).toBe('2.0k tok');
    expect(activeCostUsage(5, false)).toBe('$0.05');
    expect(activeTokenUsage(0, false)).toBe('0 tok');
    expect(activeCostUsage(0, false)).toBe('$0.00');
  });
});
