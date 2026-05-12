import { describe, expect, it } from 'vitest';
import {
  activityKindLabel,
  formatCostCents,
  formatTimestamp,
  humanDuration,
  humanTokens,
  loopStatusLabel,
  relativeTime,
  shortTime,
  terminalStatusLabel,
} from './loop-formatters.util';

describe('humanDuration', () => {
  it('renders sub-minute durations as `Ns`', () => {
    expect(humanDuration(0)).toBe('0s');
    expect(humanDuration(999)).toBe('0s');
    expect(humanDuration(1000)).toBe('1s');
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(59_999)).toBe('59s');
  });

  it('renders sub-hour durations as `NmSs`', () => {
    expect(humanDuration(60_000)).toBe('1m0s');
    expect(humanDuration(125_000)).toBe('2m5s');
    expect(humanDuration(59 * 60_000 + 59_000)).toBe('59m59s');
  });

  it('renders multi-hour durations as `NhMm`', () => {
    expect(humanDuration(60 * 60_000)).toBe('1h0m');
    expect(humanDuration(2 * 60 * 60_000 + 30 * 60_000)).toBe('2h30m');
    expect(humanDuration(25 * 60 * 60_000)).toBe('25h0m');
  });
});

describe('humanTokens', () => {
  it('renders sub-thousand counts verbatim', () => {
    expect(humanTokens(0)).toBe('0 tok');
    expect(humanTokens(999)).toBe('999 tok');
  });

  it('renders thousands with one decimal', () => {
    expect(humanTokens(1_000)).toBe('1.0k tok');
    expect(humanTokens(12_345)).toBe('12.3k tok');
    expect(humanTokens(999_999)).toBe('1000.0k tok');
  });

  it('renders millions with two decimals', () => {
    expect(humanTokens(1_000_000)).toBe('1.00M tok');
    expect(humanTokens(2_500_000)).toBe('2.50M tok');
  });
});

describe('shortTime', () => {
  it('zero-pads to HH:MM:SS', () => {
    // Avoid timezone drift by constructing from individual components.
    const ts = new Date(2024, 0, 1, 5, 7, 9).getTime();
    expect(shortTime(ts)).toBe('05:07:09');
  });
});

describe('activityKindLabel', () => {
  it('aliases known kinds and falls through unknown ones', () => {
    expect(activityKindLabel('tool_use')).toBe('tool');
    expect(activityKindLabel('input_required')).toBe('input');
    expect(activityKindLabel('stream-idle')).toBe('quiet');
    expect(activityKindLabel('error')).toBe('error');
    expect(activityKindLabel('something-new')).toBe('something-new');
  });
});

describe('terminalStatusLabel', () => {
  it('renders each terminal status exactly once', () => {
    expect(terminalStatusLabel('completed')).toBe('completed ✓');
    expect(terminalStatusLabel('cancelled')).toBe('cancelled');
    expect(terminalStatusLabel('failed')).toBe('failed');
    expect(terminalStatusLabel('cap-reached')).toBe('cap reached');
    expect(terminalStatusLabel('error')).toBe('error');
    expect(terminalStatusLabel('no-progress')).toBe('no progress');
  });
});

describe('loopStatusLabel', () => {
  it('handles terminal + intermediate statuses', () => {
    expect(loopStatusLabel('completed')).toBe('completed');
    expect(loopStatusLabel('cancelled')).toBe('cancelled');
    expect(loopStatusLabel('failed')).toBe('failed');
    expect(loopStatusLabel('cap-reached')).toBe('cap');
    expect(loopStatusLabel('error')).toBe('error');
    expect(loopStatusLabel('no-progress')).toBe('no-progress');
    expect(loopStatusLabel('paused')).toBe('paused');
    expect(loopStatusLabel('running')).toBe('running');
  });

  it('falls through unknown statuses verbatim (forward-compat)', () => {
    expect(loopStatusLabel('not-yet-defined')).toBe('not-yet-defined');
  });
});

describe('relativeTime', () => {
  // All assertions pin "now" so the values are deterministic.
  const NOW = 1_700_000_000_000;

  it('renders sub-minute differences as Ns ago, with 1s floor', () => {
    expect(relativeTime(NOW, NOW)).toBe('1s ago');
    expect(relativeTime(NOW - 999, NOW)).toBe('1s ago');
    expect(relativeTime(NOW - 5_000, NOW)).toBe('5s ago');
    expect(relativeTime(NOW - 59_000, NOW)).toBe('59s ago');
  });

  it('renders future timestamps as "just now"', () => {
    expect(relativeTime(NOW + 1000, NOW)).toBe('just now');
  });

  it('renders sub-hour, sub-day, sub-week, and older differences', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    // 8 days ago → falls into the calendar-date branch.
    const eightDaysAgo = NOW - 8 * 86_400_000;
    const result = relativeTime(eightDaysAgo, NOW);
    // Don't assert the exact month/day — locale + DST vary across CI.
    // Just confirm we left the "Nd ago" branch.
    expect(result).not.toMatch(/ago$/);
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('formatTimestamp', () => {
  it('returns a non-empty locale string for a valid timestamp', () => {
    const result = formatTimestamp(1_700_000_000_000);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('formatCostCents', () => {
  it('renders dollars-and-cents with two decimals', () => {
    expect(formatCostCents(0)).toBe('$0.00');
    expect(formatCostCents(7)).toBe('$0.07');
    expect(formatCostCents(150)).toBe('$1.50');
    expect(formatCostCents(99_999)).toBe('$999.99');
  });
});
