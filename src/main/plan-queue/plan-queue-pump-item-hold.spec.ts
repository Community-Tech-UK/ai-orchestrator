/**
 * A work source can say one job may not start now (`QueueWorkSource.itemHold`), as a ticket held by a question or waiting
 * for its blocker does. The pump asks it for a waiting worker and for a waiting check, and starts neither; a job whose
 * blocker stopped is set aside so the run can finish. The stand-in source answers by item id.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { pumpPlanQueue } from './plan-queue-pump';
import { PlanQueueRunBreaker } from './plan-queue-run-breaker';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import type { WorkItemHold } from './plan-queue-work-source';
import { WorkAdmission } from '../work-admission/work-admission';

/** Item id -> why the stand-in source says it may not start. */
const itemHolds = vi.hoisted(() => new Map<string, { note: string; setAside: boolean; question?: { question: string; options: { id: string; label: string }[]; jamesOnly: boolean } }>());

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
vi.mock('./plan-queue-work-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-queue-work-sources')>();
  const { markdownWorkSource: markdown } = await import('./plan-queue-markdown-source');
  const standIn = { ...markdown, reconcileWaiting: async () => undefined, itemHold: (item: { id: string }): WorkItemHold | null => itemHolds.get(item.id) ?? null };
  return { ...actual, workSourceForRun: () => standIn };
});

afterEach(() => WorkAdmission._resetForTesting());

describe('a work source that holds one job', () => {
  let root: string;
  beforeEach(() => { itemHolds.clear(); root = mkdtempSync(join(tmpdir(), 'queue-item-hold-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (): PlanQueueRun => ({ id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: 'running',
    config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null });

  function setUp(items: ReturnType<typeof newPlanQueueItem>[]) {
    const runs = [run()];
    const starts: string[] = [];
    const transitions: { id: string; state: string; patch: object }[] = [];
    const saves: { id: string; question: unknown }[] = [];
    const breaker = new PlanQueueRunBreaker({ getRun: () => runs[0], setRunHold: () => undefined, requestPump: () => undefined }, () => 1_000);
    const host = {
      store: { upsertItem: (item: { id: string; question?: unknown }) => { saves.push({ id: item.id, question: item.question }); Object.assign(items.find((candidate) => candidate.id === item.id)!, item); }, listActiveRuns: () => runs, listAutomaticLandingsInEndedRuns: () => [], listItems: () => items,
        listItemsWithKeptFolders: () => [], listFoldersWithDiscardedItems: () => [], listDocumentFolders: () => [],
        waits: { blocked: () => undefined, explain: () => true, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } },
      flow: { startItem: async (item: { id: string }) => { starts.push(item.id); }, startVerification: async (item: { id: string }) => { starts.push(item.id); },
        isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined },
        breaker, discardedRefs: { sweepDue: () => undefined }, recoveryCopies: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined },
        checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
      triage: { isStopping: () => false, maybeStart: () => undefined },
      getRun: () => runs[0], getItem: (id: string) => items.find((item) => item.id === id)!,
      transition: (item: { id: string }, state: string, patch: object) => { transitions.push({ id: item.id, state, patch }); return Object.assign(item, patch, { state }); },
      notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0,
      followParent: (value: PlanQueueRun) => value, isShuttingDown: () => false, isControlling: () => false,
      finishRun: () => undefined, logItemError: (_item: unknown, error: unknown) => { throw error; }, announceRun: () => undefined,
    } as unknown as Parameters<typeof pumpPlanQueue>[0];
    return { host, starts, transitions, saves };
  }

  function waiting() {
    const document = join(root, 'a_plan.md'); writeFileSync(document, '# Work');
    return [
      newPlanQueueItem('worker', 'run', document, 1, { state: 'queued' }),
      newPlanQueueItem('check', 'run', document, 2, { state: 'awaiting-slot' }),
      newPlanQueueItem('other-worker', 'run', document, 3, { state: 'queued' }),
      newPlanQueueItem('other-check', 'run', document, 4, { state: 'awaiting-slot' }),
    ];
  }

  it('starts neither a waiting worker nor a waiting check that is held, and starts the rest', async () => {
    itemHolds.set('worker', { note: 'ORC-12 changed in Linear. Answer on the Plan Queue page.', setAside: false });
    itemHolds.set('check', { note: 'ORC-12 changed in Linear. Answer on the Plan Queue page.', setAside: false });
    const { host, starts } = setUp(waiting());
    await pumpPlanQueue(host);
    expect(starts).toEqual(expect.arrayContaining(['other-worker', 'other-check']));
    expect(starts).not.toContain('worker');
    expect(starts).not.toContain('check');
  });

  it('starts a held job on the next pass once the source stops holding it', async () => {
    itemHolds.set('worker', { note: 'Waiting for ORC-11', setAside: false });
    itemHolds.set('check', { note: 'Waiting for ORC-11', setAside: false });
    const { host, starts } = setUp(waiting());
    await pumpPlanQueue(host);
    expect(starts).not.toContain('worker');
    itemHolds.clear();
    await pumpPlanQueue(host);
    expect(starts).toEqual(expect.arrayContaining(['worker', 'check']));
  });

  it('sets a job aside when its blocker stopped, so the run can finish, and starts nothing for it', async () => {
    itemHolds.set('worker', { note: 'Blocked by ORC-11, which stopped', setAside: true });
    const { host, starts, transitions } = setUp(waiting());
    await pumpPlanQueue(host);
    expect(transitions).toContainEqual({ id: 'worker', state: 'parked', patch: { heldAt: null, parkReason: 'needs-james', detail: 'Blocked by ORC-11, which stopped' } });
    expect(starts).not.toContain('worker');
  });

  const ASKED = { question: 'ORC-12 changed in Linear. Answer on the Plan Queue page.', options: [{ id: 'stop', label: 'Stop work on this ticket' }], jamesOnly: true };

  it('puts the question back on a held job that lost it (a shutdown between the hold and the saving of the question), waiting worker or waiting check', async () => {
    itemHolds.set('worker', { note: ASKED.question, setAside: false, question: ASKED });
    itemHolds.set('check', { note: ASKED.question, setAside: false, question: ASKED });
    const { host, starts, saves } = setUp(waiting());
    await pumpPlanQueue(host);
    expect(saves).toEqual(expect.arrayContaining([{ id: 'worker', question: ASKED }, { id: 'check', question: ASKED }]));
    expect(starts).not.toContain('worker');
    expect(starts).not.toContain('check');
    // Once it is there the next pass writes nothing.
    saves.length = 0;
    await pumpPlanQueue(host);
    expect(saves).toEqual([]);
  });
});
