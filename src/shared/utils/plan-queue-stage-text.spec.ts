import { describe, expect, it } from 'vitest';
import type { PlanQueueItemDto, PlanQueueItemStage } from '@contracts/schemas/plan-queue';
import { planQueueStageLine, planQueueStageSummary } from './plan-queue-stage-text';

const MIN = 60_000;
const NOW = 1_000 * MIN;

function item(stage: PlanQueueItemStage | null, overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item', runId: 'run', sourceRef: '/repo/docs/plans/desk-shared-crm_plan.md', state: 'verifying', round: 0,
    erroredRounds: 0, branchName: null, worktreePath: null, baseCommit: null, checkpointCommit: null, landedCommit: null,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: null, detail: null,
    verdict: null, createdAt: 1, updatedAt: 1, ...(stage ? { stage } : {}), ...overrides,
  };
}

const text = (stage: PlanQueueItemStage, overrides: Partial<PlanQueueItemDto> = {}) => planQueueStageLine(item(stage, overrides), NOW)?.text;

describe('planQueueStageLine', () => {
  it('says what Harness is doing, for which plan, and for how long', () => {
    expect(text({ name: 'checks', startedAt: NOW - 12 * MIN })).toBe('Checking desk-shared-crm: tests running, 12 min');
    expect(text({ name: 'landing', startedAt: NOW - 9 * MIN })).toBe('Landing desk-shared-crm: commit checks running, 9 min');
    expect(text({ name: 'waiting-for-checks', startedAt: NOW - 4 * MIN, checkWait: 'other-checks' })).toBe('desk-shared-crm: waiting for a free check slot, 4 min');
    expect(text({ name: 'waiting-to-land', startedAt: NOW - 2 * MIN })).toBe('desk-shared-crm: waiting for another job to finish landing, 2 min');
    expect(text({ name: 'waiting-for-edits', startedAt: NOW - 200 * MIN })).toBe('desk-shared-crm: passed, waiting for uncommitted edits in the main folder, 3 h 20 min');
  });

  it.each([
    ['computer-busy', 'waiting for the computer to be less busy'],
    ['harness-held', 'waiting for Harness to start new work again'],
    ['run-on-hold', 'waiting while this run is on hold'],
    ['tidying-up', 'waiting while Harness tidies up a finished job'],
    ['trying-later', 'waiting to try again'],
    ['checked-together', 'waiting to be checked with another job'],
    ['no-free-folder', 'waiting for a free work folder'],
  ] as const)('gives the real reason for a %s wait', (checkWait, words) => {
    expect(text({ name: 'waiting-for-checks', startedAt: NOW - 4 * MIN, checkWait })).toBe(`desk-shared-crm: ${words}, 4 min`);
  });

  it('never claims a slot is taken before the scheduler has looked', () => {
    expect(text({ name: 'waiting-for-checks', startedAt: NOW - 4 * MIN })).toBe('desk-shared-crm: waiting for its turn to be checked, 4 min');
  });

  it('prefers the queue\'s own note for the tooltip', () => {
    const stage: PlanQueueItemStage = { name: 'waiting-for-checks', startedAt: NOW, checkWait: 'trying-later' };
    expect(planQueueStageLine(item(stage), NOW)?.hint).toBe('Its checks could not start last time, so Harness will try again shortly.');
    expect(planQueueStageLine(item(stage, { detail: 'No usage left on this account.' }), NOW)?.hint).toBe('No usage left on this account.');
  });

  it('explains a wait for a work folder itself, as a held job\'s note only says it was paused', () => {
    const stage: PlanQueueItemStage = { name: 'waiting-for-checks', startedAt: NOW, checkWait: 'no-free-folder' };
    expect(planQueueStageLine(item(stage, { detail: 'Paused' }), NOW)?.hint).toContain('"Worktrees in use at once" setting');
  });

  it('is null for a job with no such step', () => {
    expect(planQueueStageLine(item(null), NOW)).toBeNull();
  });

  it('says a step under a minute old has just started, even against a clock slightly behind', () => {
    expect(text({ name: 'checks', startedAt: NOW - 20_000 })).toBe('Checking desk-shared-crm: tests running, just started');
    expect(text({ name: 'checks', startedAt: NOW + 5_000 })).toBe('Checking desk-shared-crm: tests running, just started');
  });

  it('leaves the time off when history has none', () => {
    expect(text({ name: 'checks', startedAt: null })).toBe('Checking desk-shared-crm: tests running');
  });

  it('says plainly when a step is taking longer than usual', () => {
    const line = planQueueStageLine(item({ name: 'checks', startedAt: NOW - 47 * MIN }), NOW)!;
    expect(line.text).toBe('Checking desk-shared-crm: tests running, 47 min (longer than usual)');
    expect(line.long).toBe(true);
    expect(line.hint).toContain('This is taking longer than usual.');
    const usual = planQueueStageLine(item({ name: 'checks', startedAt: NOW - 30 * MIN }), NOW)!;
    expect(usual.long).toBe(false);
    expect(planQueueStageLine(item({ name: 'landing', startedAt: NOW - 90 * MIN }), NOW)!.text)
      .toBe('Landing desk-shared-crm: commit checks running, 1 h 30 min (longer than usual)');
  });

  it('explains a wait with the queue\'s own note, without folder paths', () => {
    const line = planQueueStageLine(item({ name: 'waiting-for-checks', startedAt: NOW }, {
      state: 'awaiting-slot', detail: 'Checks are paused or the computer is busy.' }), NOW)!;
    expect(line.hint).toBe('Checks are paused or the computer is busy.');
    expect(planQueueStageLine(item({ name: 'waiting-for-checks', startedAt: NOW }, {
      detail: 'Waiting on /Users/someone/work/repo/notes.md' }), NOW)!.hint).not.toContain('/Users/');
  });
});

describe('planQueueStageSummary', () => {
  const line = (name: PlanQueueItemStage['name'], minutes: number, id: string) =>
    planQueueStageLine(item({ name, startedAt: NOW - minutes * MIN }, { id }), NOW)!;

  it('counts the jobs in each step and leaves out empty counts', () => {
    expect(planQueueStageSummary([line('checks', 1, 'a'), line('checks', 2, 'b'), line('landing', 3, 'c'), line('waiting-for-checks', 4, 'd')]))
      .toBe('Plan Queue: 2 checking, 1 landing, 1 waiting');
    expect(planQueueStageSummary([line('waiting-to-land', 1, 'a'), line('waiting-for-checks', 1, 'b')])).toBe('Plan Queue: 2 waiting');
  });

  it('names how many are taking longer than usual', () => {
    expect(planQueueStageSummary([line('checks', 45, 'a'), line('landing', 3, 'b')]))
      .toBe('Plan Queue: 1 checking, 1 landing, 1 taking longer than usual');
  });
});
