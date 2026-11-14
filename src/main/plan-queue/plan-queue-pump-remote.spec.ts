import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { initSqliteWasm } from '../db/sqlite-wasm-driver';
import { WorkAdmission } from '../work-admission/work-admission';

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
beforeAll(() => initSqliteWasm());
afterEach(() => WorkAdmission._resetForTesting());

/** The scheduler with a job that will run on another computer (`remoteIds`) and one that runs here. */
function setup(load: number, remoteIds: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'queue-pump-remote-'));
  const document = join(root, 'work_plan.md'); writeFileSync(document, '# Work');
  const run: PlanQueueRun = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, workerSlots: 1 }, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}_plan.md`), '# Work');
  const items: PlanQueueItem[] = [
    newPlanQueueItem('a', 'run', join(root, 'a_plan.md'), 1, { state: 'queued' }),
    newPlanQueueItem('b', 'run', join(root, 'b_plan.md'), 2, { state: 'queued' }),
  ];
  const starts: string[] = [];
  const host = {
    store: { listActiveRuns: () => [run], listAutomaticLandingsInEndedRuns: () => [], listItems: () => items, listItemsWithKeptFolders: () => [],
      listFoldersWithDiscardedItems: () => [], waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } },
    flow: { startItem: async (item: PlanQueueItem) => { starts.push(item.id); }, isWaitingForUsage: () => false, isClaimed: () => false, keptFolders: { retryDue: () => undefined },
      breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, recoveryCopies: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(),
      startVerification: async () => undefined, willRunElsewhere: (item: PlanQueueItem) => remoteIds.includes(item.id) },
    triage: null, getRun: () => run, getItem: (id: string) => items.find(item => item.id === id)!,
    transition: (item: object, state: string, patch: object) => Object.assign(item, patch, { state }),
    notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [load, load, load], queueFolderLimit: () => 0, followParent: (value: PlanQueueRun) => value,
    isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined,
    logItemError: (_item: unknown, error: unknown) => { throw error; }, announceRun: () => undefined,
  } as unknown as Parameters<typeof pumpPlanQueue>[0];
  return { host, starts, items, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe('the scheduler and jobs on other computers', () => {
  it('counts a job that runs elsewhere apart from the run\'s own worker slot', async () => {
    const s = setup(0, ['a']);
    try {
      await pumpPlanQueue(s.host);
      // One slot here (workerSlots 1) and one place on the computer: both start.
      expect(s.starts).toEqual(['a', 'b']);
    } finally { s.dispose(); }
  });

  it('does not count a running remote job against the slot here', async () => {
    const s = setup(0, ['a']);
    try {
      s.items[0] = Object.assign(s.items[0]!, { state: 'working', remote: { nodeId: 'pc', label: 'the Windows PC', branch: 'queue/a', lastExchangedCommit: null, turnStartCommit: null, turnId: 't' } });
      await pumpPlanQueue(s.host);
      expect(s.starts).toEqual(['b']);
    } finally { s.dispose(); }
  });

  it('still limits jobs here to the run\'s slots', async () => {
    const s = setup(0, []);
    try {
      await pumpPlanQueue(s.host);
      expect(s.starts).toEqual(['a']);
    } finally { s.dispose(); }
  });

  it('starts a job bound for another computer while this Mac is busy, and holds one that would run here', async () => {
    const s = setup(100, ['a']);
    try {
      await pumpPlanQueue(s.host);
      expect(s.starts).toEqual(['a']);
    } finally { s.dispose(); }
  });

  it('is unchanged when the flow has no remote support', async () => {
    const s = setup(0, []);
    try {
      delete (s.host.flow as { willRunElsewhere?: unknown }).willRunElsewhere;
      await pumpPlanQueue(s.host);
      expect(s.starts).toEqual(['a']);
    } finally { s.dispose(); }
  });
});
