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
  setAsideRounds: { items: 12, rounds: 41 }, repeatFailingTests: [], lateFindings: { critical: 0, high: 0, medium: 0, low: 0 },
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
      'Tests failing in more than one job': 'None',
      'New findings from round 3 on': 'None',
    });
  });

  describe('the test machine', () => {
    const testMachine = {
      label: 'the Windows PC', ranThere: { count: 27, of: 34, share: 27 / 34 }, movedToMac: { count: 0, of: 27, share: 0 }, unreachable: false,
    };
    const lineFor = (machine: PlanQueueHealth['testMachine']) => Object.fromEntries(
      describeQueueHealth({ ...health, testMachine: machine }).lines.map(line => [line.label, line.value]));

    it('adds where full runs went, and nothing when no machine is set up', () => {
      expect(lineFor(testMachine)).toMatchObject({
        'Full test runs on the Windows PC': '79% (27 of 34 full test runs)', 'Full test runs that moved to the Mac': 'None',
      });
      expect(Object.keys(lineFor(undefined)).filter(label => label.startsWith('Full test runs'))).toEqual([]);
    });

    it('counts runs that moved to the Mac', () => {
      expect(lineFor({ ...testMachine, movedToMac: { count: 2, of: 29, share: 2 / 29 } })['Full test runs that moved to the Mac'])
        .toBe('7% (2 of 29 full test runs)');
    });

    it('stays quiet while tests run where they should', () => {
      expect(describeQueueHealth({ ...health, testMachine }).notice).toBeNull();
      expect(describeQueueHealth(health).notice).toBeNull();
    });

    it('says what happened and what to do when the machine cannot be reached', () => {
      expect(describeQueueHealth({ ...health, testMachine: { ...testMachine, unreachable: true } }).notice)
        .toBe("Tests are running on this Mac because the Windows PC can't be reached. Check it's switched on and connected. Tests go back to it by themselves.");
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

  it('names tests that keep failing across jobs', () => {
    const line = (repeatFailingTests: PlanQueueHealth['repeatFailingTests']) => describeQueueHealth({ ...health, repeatFailingTests }).lines
      .find(row => row.label === 'Tests failing in more than one job')?.value;
    expect(line([])).toBe('None');
    expect(line([{ test: 'src/a.spec.ts › works', jobs: 3 }, { test: 'src/b.spec.ts › also', jobs: 2 }]))
      .toBe('src/a.spec.ts › works (3 jobs); src/b.spec.ts › also (2 jobs)');
  });

  it('counts late findings by severity, leaving out the empty ones', () => {
    const { lines } = describeQueueHealth({ ...health, lateFindings: { critical: 0, high: 2, medium: 7, low: 0 } });
    expect(lines.find(row => row.label === 'New findings from round 3 on')?.value).toBe('2 high, 7 medium');
  });

  it('formats durations', () => {
    expect([1000, 59_000, 60_000, 4 * MIN, 60 * MIN, 80 * MIN].map(describeHealthDuration))
      .toEqual(['1 second', '59 seconds', '1 min', '4 min', '1 h', '1 h 20 min']);
  });
});
