import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueItemDto, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import type { PlanQueueItemEvent } from './plan-queue-history-store';
import { describeRunEvidence, PLAN_QUEUE_EVIDENCE_EVENT_LIMIT } from './plan-queue-run-evidence';

const GROUP = { id: 'group-1', baseTip: 'base-tip', memberItemIds: ['lambda', 'mu', 'kappa'] };

function item(id: string, overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return { id, runId: 'run', sourceRef: `/repo/docs/plans/${id}_plan.md`, state: 'landed', round: 1, erroredRounds: 0,
    branchName: null, worktreePath: null, baseCommit: 'base-tip', checkpointCommit: `${id}-checkpoint`, landedCommit: `${id}-landed`,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: null, detail: null,
    verdict: { verdict: 'PASS', findings: [], documentComplete: true, needJames: [], notChecked: [],
      gatesRun: [{ command: 'node --test', exitCode: 0, head: `${id}-head`, testedTree: 'shared-tree', checkGroup: GROUP, tail: 'long test output' }] },
    createdAt: 1, updatedAt: 1, ...overrides };
}

function run(items: PlanQueueItemDto[], overrides: Partial<PlanQueueRunDto> = {}): PlanQueueRunDto {
  return { id: 'run', parentInstanceId: 'parent', kind: 'plans', workspaceCwd: '/repo', status: 'completed',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, checkBatchSize: 4, verifierGates: ['node --test'], postMergeGate: [] },
    workerProvider: 'claude', relaxedSettings: [], startedAt: 1_000, endedAt: 2_000, items, ...overrides };
}

function event(id: string, at: number, overrides: Partial<PlanQueueItemEvent> = {}): PlanQueueItemEvent {
  return { id, itemId: 'lambda', runId: 'run', at, fromState: 'verifying', toState: 'verifying', reason: null, detailHead: null, round: 0, tokens: 0, ...overrides };
}

describe('describeRunEvidence', () => {
  it('gives a finished group the page\'s words and each member\'s own receipt without its output', () => {
    const evidence = describeRunEvidence(run([item('lambda'), item('mu'), item('kappa')], { checks: { runs: 1, jobs: 3 } }), [], 5_000);
    expect(evidence.onPage).toEqual({ checks: '1 test run covered 3 jobs' });
    expect(evidence.items.map(entry => entry.onPage)).toEqual(Array(3).fill({ checkedTogether: 'Checked together with 2 other jobs' }));
    expect(evidence.items[1]).toMatchObject({ document: 'mu', baseCommit: 'base-tip', checkpointCommit: 'mu-checkpoint', landedCommit: 'mu-landed',
      receipts: [{ head: 'mu-head', testedTree: 'shared-tree', checkGroup: GROUP }] });
    expect(JSON.stringify(evidence)).not.toContain('long test output');
    expect(evidence.settings).toMatchObject({ checkBatchSize: 4, verifierGates: ['node --test'], postMergeGate: [] });
    expect(evidence).toMatchObject({ startedAt: '1970-01-01T00:00:01.000Z', endedAt: '1970-01-01T00:00:02.000Z' });
  });

  it('gives a waiting job the page\'s step line, with the note that names what it is checked with', () => {
    const waiting = item('mu', { state: 'awaiting-slot', verdict: null, detail: 'Being checked with lambda.',
      stage: { name: 'waiting-for-checks', startedAt: 0, checkWait: 'other-checks' } });
    const evidence = describeRunEvidence(run([waiting], { status: 'running', endedAt: null }), [], 120_000);
    expect(evidence.onPage).toEqual({});
    expect(evidence.endedAt).toBeNull();
    expect(evidence.items[0].onPage).toEqual({ step: 'mu: waiting for a free check slot, 2 min', stepHint: 'Being checked with lambda.' });
    expect(evidence.items[0].receipts).toEqual([]);
  });

  it('puts the timeline in time order and names each document', () => {
    const { timeline } = describeRunEvidence(run([item('lambda')]), [
      event('late', 2_000, { reason: 'checklist-run', detailHead: '{"groupId":"group-1"}' }),
      event('early', 1_000, { fromState: 'awaiting-slot' }),
      event('gone', 500, { itemId: 'no-longer-listed', fromState: null }),
    ], 5_000);
    expect(timeline).toEqual([
      { at: '1970-01-01T00:00:00.500Z', document: 'no-longer-listed', from: null, to: 'verifying', round: 0 },
      { at: '1970-01-01T00:00:01.000Z', document: 'lambda', from: 'awaiting-slot', to: 'verifying', round: 0 },
      { at: '1970-01-01T00:00:02.000Z', document: 'lambda', from: 'verifying', to: 'verifying', round: 0, reason: 'checklist-run', detail: '{"groupId":"group-1"}' },
    ]);
  });

  it('keeps the newest events of a long run and says earlier ones were left out', () => {
    const newestFirst = Array.from({ length: PLAN_QUEUE_EVIDENCE_EVENT_LIMIT + 1 }, (_, index) => event(`e${index}`, 10_000 - index));
    const evidence = describeRunEvidence(run([item('lambda')]), newestFirst, 20_000);
    expect(evidence.timeline).toHaveLength(PLAN_QUEUE_EVIDENCE_EVENT_LIMIT);
    expect(evidence.timeline.at(-1)?.at).toBe(new Date(10_000).toISOString());
    expect(evidence).toMatchObject({ earlierEventsLeftOut: true });
    expect(describeRunEvidence(run([item('lambda')]), newestFirst.slice(1), 20_000)).not.toHaveProperty('earlierEventsLeftOut');
  });
});
