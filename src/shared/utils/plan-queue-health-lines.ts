/**
 * The words for "Queue health", written once for the Plan Queue page and for `plan_queue_status`, so the two never
 * describe a measure differently. Plain English, no internal names (docs/screen-and-wording-guide.md).
 */
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';

export interface PlanQueueHealthLine { label: string; value: string }

/** "45 seconds", "4 min", "1 h 20 min". */
export function describeHealthDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const NOT_YET = 'Nothing measured yet';

function shareValue(measure: { count: number; of: number; share: number | null }, noun: string): string {
  return measure.share === null ? NOT_YET : `${percent(measure.share)} (${measure.count} of ${measure.of} ${noun})`;
}

function typical(measure: { count: number; medianMs: number | null }, noun: string): string {
  return measure.medianMs === null ? NOT_YET : `${describeHealthDuration(measure.medianMs)} typically (${measure.count} ${noun})`;
}

function landingValue(landing: PlanQueueHealth['landingTime']): string {
  if (landing.medianMs === null) return NOT_YET;
  const parts = ([
    ['bringing in the base branch', landing.syncMs], ['checks after that', landing.mergeCheckMs],
    ['the pre-commit check', landing.commitCheckMs], ['adding it to the base branch', landing.publishMs],
  ] as const).flatMap(([name, ms]) => ms === null ? [] : [`${name} ${describeHealthDuration(ms)}`]);
  return `${typical(landing, 'landings')}${parts.length ? `: ${parts.join(', ')}` : ''}`;
}

function testMachineLines(testMachine: PlanQueueHealth['testMachine']): PlanQueueHealthLine[] {
  if (!testMachine) return [];
  const { label, ranThere, movedToMac } = testMachine;
  return [
    { label: `Full test runs on ${label}`, value: shareValue(ranThere, 'full test runs') },
    { label: 'Full test runs that moved to the Mac', value: movedToMac.count === 0 ? 'None' : shareValue(movedToMac, 'full test runs') },
  ];
}

/**
 * Said only while it's true: when tests are running where they should, this panel adds nothing. The label is one
 * machine or "your test machines", so the wording uses no pronoun for it.
 */
function testMachineNotice(testMachine: PlanQueueHealth['testMachine']): string | null {
  return testMachine?.unreachable
    ? `Tests are running on this Mac because ${testMachine.label} can't be reached. Check the power and the network connection. Tests move back by themselves.`
    : null;
}

/** The measures in reading order. Every figure covers the recent window and finished work only. */
export function describeQueueHealth(health: PlanQueueHealth): { heading: string; lines: PlanQueueHealthLine[]; notice: string | null } {
  const { waiting, setAsideRounds, repeatFailingTests, lateFindings } = health;
  const late = (['critical', 'high', 'medium', 'low'] as const).filter(severity => lateFindings[severity] > 0)
    .map(severity => `${lateFindings[severity]} ${severity}`);
  return {
    heading: `Queue health, last ${health.windowDays} days`,
    notice: testMachineNotice(health.testMachine),
    lines: [
      { label: 'Attempts that land', value: shareValue(health.attemptsLanded, 'finished attempts') },
      { label: 'Documents that land', value: shareValue(health.documentsLanded, 'documents') },
      { label: 'Passed checks that did not land', value: shareValue(health.passesNotLanded, 'passed checks') },
      { label: 'Passed the first check', value: shareValue(health.firstCheckPassed, 'checked attempts') },
      { label: 'Wait from a free slot to the next start', value: typical(health.freeSlotToStart, 'starts') },
      { label: 'Time a check takes', value: typical(health.checkTime, 'checks') },
      { label: 'Time to land', value: landingValue(health.landingTime) },
      { label: 'Time spent waiting rather than working', value: waiting.share === null ? NOT_YET
        : `${percent(waiting.share)} (${describeHealthDuration(waiting.waitingMs)} waiting for a free slot or for usage, ${describeHealthDuration(waiting.workingMs)} working)` },
      { label: 'Rounds spent on items that were set aside', value: setAsideRounds.items === 0 ? 'None'
        : `${setAsideRounds.rounds} ${setAsideRounds.rounds === 1 ? 'round' : 'rounds'} on ${setAsideRounds.items} ${setAsideRounds.items === 1 ? 'item' : 'items'}` },
      { label: 'Tests failing in more than one job', value: repeatFailingTests.length === 0 ? 'None'
        : repeatFailingTests.map(({ test, jobs }) => `${test} (${jobs} jobs)`).join('; ') },
      { label: 'New findings from round 3 on', value: late.length ? late.join(', ') : 'None' },
      ...testMachineLines(health.testMachine),
    ],
  };
}
