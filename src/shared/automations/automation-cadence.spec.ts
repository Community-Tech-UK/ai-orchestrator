import { Cron } from 'croner';
import { describe, expect, it } from 'vitest';
import type { AutomationSchedule } from '../types/automation.types';
import {
  AGENT_AUTOMATION_MAX_RUNS_PER_DAY,
  estimateDailyRuns,
} from './automation-cadence';

// A fixed Saturday so "measured on a Saturday" is deterministic.
const SATURDAY = new Date('2026-10-10T12:00:00Z');

describe('estimateDailyRuns (A15 / 8f)', () => {
  it('counts James\'s 12-a-day mail job shape as 12', () => {
    expect(
      estimateDailyRuns(
        { type: 'cron', expression: '*/15 9-11 * * 1-5', timezone: 'Europe/London' },
        SATURDAY,
      ),
    ).toBe(12);
  });

  it('counts a */5 cron as 288 a day', () => {
    expect(
      estimateDailyRuns({ type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' }, SATURDAY),
    ).toBe(288);
  });

  it('measures a weekday-only cron at its weekday count even on a Saturday', () => {
    expect(
      estimateDailyRuns({ type: 'cron', expression: '0 9 * * 1-5', timezone: 'UTC' }, SATURDAY),
    ).toBe(1);
  });

  it('treats a one-time run as a single start', () => {
    expect(
      estimateDailyRuns(
        { type: 'oneTime', runAt: SATURDAY.getTime() + 60 * 60 * 1000 },
        SATURDAY,
      ),
    ).toBe(1);
  });

  it('exposes the 24-a-day agent threshold', () => {
    expect(AGENT_AUTOMATION_MAX_RUNS_PER_DAY).toBe(24);
  });
});

/**
 * The pre-T10 implementation, kept verbatim as the reference the fast one must
 * match. It is slow (croner's timezone mode costs about 90 microseconds a
 * step), which is why the matrix below is bounded.
 */
function legacyEstimateDailyRuns(schedule: AutomationSchedule, now: Date): number {
  if (schedule.type === 'oneTime') {
    return schedule.runAt > now.getTime() ? 1 : 0;
  }
  const dayKey = (date: Date): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: schedule.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  };
  const cron = new Cron(schedule.expression, { timezone: schedule.timezone, paused: true });
  try {
    const until = now.getTime() + 7 * 24 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    let cursor = now;
    for (let i = 0; i < 20_000; i += 1) {
      const next = cron.nextRun(cursor);
      if (!next || next.getTime() > until) break;
      const key = dayKey(next);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      cursor = next;
    }
    return counts.size > 0 ? Math.max(...counts.values()) : 0;
  } finally {
    cron.stop();
  }
}

const HOUR = 60 * 60 * 1000;
const cron = (expression: string, timezone: string): AutomationSchedule => ({
  type: 'cron',
  expression,
  timezone,
});

/** Real 2026 offset changes (instant of the change, from Intl). */
const TRANSITIONS: [timezone: string, instant: string][] = [
  ['Europe/London', '2026-03-29T01:00:00Z'],
  ['Europe/London', '2026-10-25T01:00:00Z'],
  ['America/New_York', '2026-03-08T07:00:00Z'],
  ['America/New_York', '2026-11-01T06:00:00Z'],
  ['Australia/Lord_Howe', '2026-04-04T15:00:00Z'],
  ['Australia/Lord_Howe', '2026-10-03T15:30:00Z'],
  ['America/St_Johns', '2026-03-08T05:30:00Z'],
  ['Pacific/Chatham', '2026-09-26T14:00:00Z'],
  ['Antarctica/Troll', '2026-03-29T01:00:00Z'],
];
/** Starting points around a change: a day before, inside the window, just after. */
const AROUND = [-26 * HOUR, -HOUR, -20 * 60_000, 0, 90 * 60_000, 25 * HOUR];

describe('estimateDailyRuns matches the pre-T10 implementation (T10)', () => {
  // The reference is slow, so each test stays small enough to finish in a
  // couple of seconds without starving the test runner.
  const MODERATE = [
    '*/15 9-11 * * 1-5',
    '0 9 * * 1-5',
    '30 1 * * *',
    '30 2 * * *',
    '0 3 * * *',
    '0 * * * *',
    '*/30 0-3 * * *',
    '5 4 * * sun',
    '0 9 L * *',
    // Clusters that straddle UTC midnight in one zone or another, so a day
    // counted by UTC date instead of the local date gives a different answer.
    '*/15 5-6 * * *',
    '*/15 12-13 * * *',
    '*/15 19-20 * * *',
  ];
  const LEGACY_COMPARISON_TIMEOUT_MS = 60_000;
  const expectSame = (schedule: AutomationSchedule, now: Date): void => {
    const label = schedule.type === 'cron' ? `${schedule.expression} ${schedule.timezone}` : 'oneTime';
    expect(estimateDailyRuns(schedule, now), `${label} from ${now.toISOString()}`)
      .toBe(legacyEstimateDailyRuns(schedule, now));
  };

  it.each(['UTC', 'Europe/London', 'America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])(
    'gives the same answer on ordinary days in %s',
    (timezone) => {
      for (const now of [new Date('2026-10-10T12:00:00Z'), new Date('2026-07-15T03:17:41.250Z')]) {
        for (const expression of MODERATE) expectSame(cron(expression, timezone), now);
      }
    },
  );

  it.each(TRANSITIONS)('gives the same answer around the %s change at %s', (timezone, instant) => {
    for (const expression of MODERATE) {
      for (const delta of AROUND) {
        expectSame(cron(expression, timezone), new Date(Date.parse(instant) + delta));
      }
    }
  });

  it.each([
    ['*/5 * * * *', 'Europe/London', '2026-10-24T12:00:00Z'],
    ['*/5 * * * *', 'America/New_York', '2026-03-08T00:00:00Z'],
    ['*/5 * * * *', 'Europe/London', '2026-10-10T12:00:00Z'],
    ['* * * * *', 'Europe/London', '2026-10-10T12:00:00Z'],
    ['* * * * *', 'America/New_York', '2026-11-01T05:30:00Z'],
    ['* * * * *', 'Australia/Lord_Howe', '2026-04-04T14:00:00Z'],
  ])('gives the same answer for busy %s in %s from %s', (expression, timezone, start) => {
    expectSame(cron(expression, timezone), new Date(start));
  }, LEGACY_COMPARISON_TIMEOUT_MS);

  // The legacy reference walks up to 20,000 fires at about 90 microseconds each, which
  // is seconds of CPU on an idle host and several times that when the host is loaded.
  // The default 5 s timeout made this flaky; the explicit one is generous, and the
  // equality assertion is unchanged.
  it('keeps the 20,000-fire safety bound for schedules that fire every few seconds', () => {
    expectSame(cron('*/20 * * * * *', 'Europe/London'), new Date('2026-10-10T12:00:00Z'));
  }, LEGACY_COMPARISON_TIMEOUT_MS);

  it('still reports a nonexistent run date as zero and rejects bad input like before', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(estimateDailyRuns(cron('0 0 31 2 *', 'UTC'), now)).toBe(0);
    expect(() => estimateDailyRuns(cron('not a cron', 'UTC'), now)).toThrow();
    expect(() => estimateDailyRuns(cron('0 9 * * *', 'Not/AZone'), now)).toThrow();
    expect(() => legacyEstimateDailyRuns(cron('0 9 * * *', 'Not/AZone'), now)).toThrow();
  });
});

describe('estimateDailyRuns speed (T10)', () => {
  // The old code took 249 ms for every-5-minutes and 1.16 s for every minute.
  // The page recomputes on edits and the agent guard blocks the main process,
  // so the budget is loose for CI noise but far under the old numbers.
  //
  // The budget is CPU time (user plus system, from process.cpuUsage()), not wall
  // clock. At a host load of 30 to 40 the wall clock of an unchanged 100 ms job
  // stretches past the budget while the CPU it burns stays put, and the old code
  // is far over the budget in CPU time too (see above), so the budget still means
  // what it said. Vitest runs the tests of one file one after another, so nothing
  // else in this process competes for the measurement.
  const BUDGET_MS = 120;
  const time = (schedule: AutomationSchedule, now: Date): number => {
    const start = process.cpuUsage();
    estimateDailyRuns(schedule, now);
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  const best = (schedule: AutomationSchedule, now: Date, attempts = 2): number =>
    Math.min(...Array.from({ length: attempts }, () => time(schedule, now)));

  it.each([
    ['*/5 * * * *', 'Europe/London'],
    ['* * * * *', 'Europe/London'],
    ['* * * * *', 'America/New_York'],
    ['*/15 9-11 * * 1-5', 'Europe/London'],
  ])('answers %s in %s well inside the budget', (expression, timezone) => {
    const now = new Date('2026-10-10T12:00:00Z');
    time(cron(expression, timezone), now); // warm up
    expect(best(cron(expression, timezone), now)).toBeLessThan(BUDGET_MS);
  });

  it('stays inside the budget on the day the clocks change', () => {
    const now = new Date('2026-10-24T20:00:00Z');
    time(cron('* * * * *', 'Europe/London'), now);
    expect(best(cron('* * * * *', 'Europe/London'), now)).toBeLessThan(BUDGET_MS * 2);
  });

  it('stays inside the budget for a schedule that fires every few seconds', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    time(cron('*/20 * * * * *', 'Europe/London'), now);
    expect(best(cron('*/20 * * * * *', 'Europe/London'), now)).toBeLessThan(BUDGET_MS * 2);
  });
});
