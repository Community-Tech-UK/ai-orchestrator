import { describe, expect, it } from 'vitest';
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { describeHealthDuration, describeQueueHealth } from './plan-queue-health-lines';

const MIN = 60_000;
const health: PlanQueueHealth = {
  windowDays: 14, since: 0,
  attemptsLanded: { count: 238, of: 615, share: 238 / 615 },
  documentsLanded: { count: 218, of: 408, share: 218 / 408 },
  passesNotLanded: { count: 96, of: 333, share: 96 / 333 },
  firstCheckPassed: { count: 4, of: 10, share: 0.4 },
  freeSlotToStart: { count: 12, medianMs: 40_000 },
  checkTime: { count: 9, medianMs: 25 * MIN },
  landingTime: { count: 5, medianMs: 9 * MIN, syncMs: 10_000, mergeCheckMs: null, commitCheckMs: 8 * MIN, publishMs: 2_000 },
  waiting: { waitingMs: 30 * MIN, workingMs: 90 * MIN, share: 0.25 },
  setAsideRounds: { items: 12, rounds: 41 },
};

describe('Queue health wording', () => {
  it('describes each measure in plain language', () => {
    const { heading, lines } = describeQueueHealth(health);
    expect(heading).toBe('Queue health, last 14 days');
    expect(Object.fromEntries(lines.map(line => [line.label, line.value]))).toEqual({
      'Attempts that land': '39% (238 of 615 finished attempts)',
      'Documents that land': '53% (218 of 408 documents)',
      'Passed checks that did not land': '29% (96 of 333 passed checks)',
      'Passed the first check': '40% (4 of 10 checked attempts)',
      'Wait from a free slot to the next start': '40 seconds typically (12 starts)',
      'Time a check takes': '25 min typically (9 checks)',
      'Time to land': '9 min typically (5 landings): bringing in the base branch 10 seconds, the pre-commit check 8 min, adding it to the base branch 2 seconds',
      'Time spent waiting rather than working': '25% (30 min waiting for a free slot or for usage, 1 h 30 min working)',
      'Rounds spent on items that were set aside': '41 rounds on 12 items',
    });
  });

  it('says so, rather than showing zero, when nothing is measured', () => {
    const empty: PlanQueueHealth = { ...health,
      attemptsLanded: { count: 0, of: 0, share: null }, freeSlotToStart: { count: 0, medianMs: null },
      landingTime: { count: 0, medianMs: null, syncMs: null, mergeCheckMs: null, commitCheckMs: null, publishMs: null },
      waiting: { waitingMs: 0, workingMs: 0, share: null }, setAsideRounds: { items: 0, rounds: 0 } };
    const values = Object.fromEntries(describeQueueHealth(empty).lines.map(line => [line.label, line.value]));
    expect(values['Attempts that land']).toBe('Nothing measured yet');
    expect(values['Wait from a free slot to the next start']).toBe('Nothing measured yet');
    expect(values['Time to land']).toBe('Nothing measured yet');
    expect(values['Time spent waiting rather than working']).toBe('Nothing measured yet');
    expect(values['Rounds spent on items that were set aside']).toBe('None');
  });

  it('formats durations', () => {
    expect([1000, 59_000, 60_000, 4 * MIN, 60 * MIN, 80 * MIN].map(describeHealthDuration))
      .toEqual(['1 second', '59 seconds', '1 min', '4 min', '1 h', '1 h 20 min']);
  });
});
