/**
 * A work source can say its run may not start new work (`QueueWorkSource.reasonToHold`). No Linear run exists until
 * programme step 7.3, so these tests use a stand-in source that reports a reason for the runs they name; the real pause
 * of a real Linear run is checked live by the phase that adds Linear runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { runToDto } from './plan-queue-messages';
import { pumpPlanQueue } from './plan-queue-pump';
import { PlanQueueRunBreaker } from './plan-queue-run-breaker';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import { markdownWorkSource } from './plan-queue-markdown-source';
import { WorkAdmission } from '../work-admission/work-admission';

/** Run id -> the stand-in source's reason. A run not in the map uses the real markdown source. */
const sourceReasons = vi.hoisted(() => new Map<string, string | null>());

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
vi.mock('./plan-queue-work-sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-queue-work-sources')>();
  const { markdownWorkSource: markdown } = await import('./plan-queue-markdown-source');
  const standIn = (run: { id: string }) => ({
    ...markdown,
    reconcileWaiting: async () => undefined,
    reasonToHold: () => sourceReasons.get(run.id) ?? null,
  });
  return { ...actual, workSourceForRun: (run: { id: string; kind: string }) => (sourceReasons.has(run.id) ? standIn(run) : actual.workSourceForRun(run)) };
});

afterEach(() => WorkAdmission._resetForTesting());

const REASON = 'Linear work is paused: stand-in reason.';

describe('a work source that holds its run', () => {
  const roots: string[] = [];
  beforeEach(() => sourceReasons.clear());
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  /** One folder, shared by every run the test makes, as two runs in one project folder are. */
  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), 'queue-source-hold-')); roots.push(root);
    return root;
  }
  function runIn(root: string, id: string, holdReason?: string): PlanQueueRun {
    return { id, parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null,
      ...(holdReason ? { holdReason } : {}) };
  }
  /** A run with one waiting worker, one waiting check and one document triage has not read yet. */
  function waitingWork(root: string, run: PlanQueueRun) {
    const document = join(root, `${run.id}_plan.md`); writeFileSync(document, '# Work');
    return [
      newPlanQueueItem(`${run.id}-worker`, run.id, document, 1, { state: 'queued' }),
      newPlanQueueItem(`${run.id}-check`, run.id, document, 2, { state: 'awaiting-slot' }),
      newPlanQueueItem(`${run.id}-new`, run.id, document, 3, { state: 'discovered' }),
    ];
  }

  function setUp(runs: PlanQueueRun[], items: ReturnType<typeof newPlanQueueItem>[], now: () => number = () => 1_000) {
    const starts: string[] = [];
    const holds: { runId: string; holdReason: string | null }[] = [];
    const explained: { id: string; why: string }[] = [];
    const breaker = new PlanQueueRunBreaker({
      getRun: (id) => runs.find((run) => run.id === id)!,
      setRunHold: (runId, holdReason) => { holds.push({ runId, holdReason }); },
      requestPump: () => undefined,
    }, now);
    const host = {
      store: { listActiveRuns: () => runs, listAutomaticLandingsInEndedRuns: () => [], listItems: (id: string) => items.filter((item) => item.runId === id),
        listItemsWithKeptFolders: () => [], listFoldersWithDiscardedItems: () => [], listDocumentFolders: () => [],
        waits: { blocked: () => undefined, explain: (id: string, why: string) => { explained.push({ id, why }); return true; }, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } },
      flow: { startItem: async (item: { id: string }) => { starts.push(item.id); }, startVerification: async (item: { id: string }) => { starts.push(item.id); },
        isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined },
        breaker, discardedRefs: { sweepDue: () => undefined }, recoveryCopies: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined },
        checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
      triage: { isStopping: () => false, maybeStart: (run: PlanQueueRun) => { starts.push(`triage:${run.id}`); } },
      getRun: (id: string) => runs.find((run) => run.id === id)!, getItem: (id: string) => items.find((item) => item.id === id)!,
      transition: (item: object, state: string, patch: object) => Object.assign(item, patch, { state }),
      notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0,
      followParent: (value: PlanQueueRun) => value, isShuttingDown: () => false, isControlling: () => false,
      finishRun: () => undefined, logItemError: (_item: unknown, error: unknown) => { throw error; }, announceRun: () => undefined,
    } as unknown as Parameters<typeof pumpPlanQueue>[0];
    return { host, starts, holds, explained, breaker };
  }

  it('starts no worker, check or triage in the held run while a markdown run in the same pass starts its work', async () => {
    const root = folder();
    const held = runIn(root, 'held'); const plain = runIn(root, 'plain');
    sourceReasons.set('held', REASON);
    const items = [...waitingWork(root, held), ...waitingWork(root, plain)];
    const { host, starts, explained } = setUp([held, plain], items);
    await pumpPlanQueue(host);
    expect(starts.filter((entry) => entry.includes('held'))).toEqual([]);
    expect(starts).toEqual(expect.arrayContaining(['triage:plain', 'plain-worker', 'plain-check']));
    // The held run's waiting check says the run is on hold, in the words the page already has for that wait.
    expect(explained).toContainEqual({ id: 'held-check', why: 'run-on-hold' });
  });

  it('lets work that is already running carry on to its end', async () => {
    const root = folder();
    const held = runIn(root, 'held');
    sourceReasons.set('held', REASON);
    const document = join(root, 'held_plan.md'); writeFileSync(document, '# Work');
    const items = [newPlanQueueItem('working', 'held', document, 1, { state: 'working' }), newPlanQueueItem('checking', 'held', document, 2, { state: 'verifying' })];
    const { host, starts } = setUp([held], items);
    await pumpPlanQueue(host);
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    expect(items.map((item) => item.state)).toEqual(['working', 'verifying']);
    // Work running in the held run finishes as it would anywhere: the pump neither stops it nor starts another beside it.
    items[0].state = 'awaiting-slot';
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    expect(items[0].state).toBe('awaiting-slot');
  });

  it('starts the waiting work on the next pass once the reason clears', async () => {
    const root = folder();
    const held = runIn(root, 'held');
    sourceReasons.set('held', REASON);
    const items = waitingWork(root, held);
    const { host, starts } = setUp([held], items);
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    sourceReasons.set('held', null);
    await pumpPlanQueue(host);
    expect(starts).toEqual(expect.arrayContaining(['triage:held', 'held-worker', 'held-check']));
  });

  it('with two held runs and one markdown run in the same folder, only the markdown run starts work', async () => {
    const root = folder();
    const heldOne = runIn(root, 'held-one'); const heldTwo = runIn(root, 'held-two'); const plain = runIn(root, 'plain');
    sourceReasons.set('held-one', REASON); sourceReasons.set('held-two', 'Linear work is paused: another reason.');
    const items = [...waitingWork(root, heldOne), ...waitingWork(root, heldTwo), ...waitingWork(root, plain)];
    const { host, starts } = setUp([heldOne, heldTwo, plain], items);
    await pumpPlanQueue(host);
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((entry) => entry.includes('plain'))).toBe(true);
    expect(starts).toEqual(expect.arrayContaining(['triage:plain', 'plain-worker', 'plain-check']));
  });

  it('starts nothing in a held run on the first pass after a restart, while the connection is still being checked', async () => {
    const root = folder();
    const held = runIn(root, 'held');
    const items = waitingWork(root, held);
    // A restarted app has forgotten its last answer, so Step 3's service says "checking" and holds the run.
    sourceReasons.set('held', 'Linear work waits while Harness checks the connection.');
    const { host, starts } = setUp([held], items);
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    // The check finishes and the connection is usable: the next pass starts the work.
    sourceReasons.set('held', null);
    await pumpPlanQueue(host);
    expect(starts).toEqual(expect.arrayContaining(['held-worker']));
  });

  it("neither starts a trial job for, nor clears, a hold that is the source's", async () => {
    const root = folder();
    const held = runIn(root, 'held');
    sourceReasons.set('held', REASON);
    const items = waitingWork(root, held);
    const { host, starts, holds, breaker } = setUp([held], items);
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    // The breaker never saw the source's reason: no hold text was written, so no trial window was opened.
    expect(holds).toEqual([]);
    expect(held.holdReason).toBeUndefined();
    expect(breaker.canStart(held)).toBe(true);
  });

  it('does not spend the breaker trial of a run that has its own hold while the source also holds it', async () => {
    const root = folder();
    const own = 'No new work is starting, because three jobs failed the same way. Last error: boom';
    const held = runIn(root, 'held', own);
    sourceReasons.set('held', REASON);
    const items = waitingWork(root, held);
    let now = 1_000;
    const { host, starts, holds, breaker } = setUp([held], items, () => now);
    expect(breaker.canStart(held)).toBe(false); // the breaker opens its trial window now, the first trial due in ten minutes
    await pumpPlanQueue(host);
    now += 11 * 60_000; // the first trial is due
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    expect(held.holdReason).toBe(own);
    expect(holds).toEqual([]);
    // Once the source is usable again the breaker's own trial is still waiting and goes ahead.
    sourceReasons.set('held', null);
    await pumpPlanQueue(host);
    expect(starts.length).toBe(1);
    expect(held.holdReason).toBe(own);
  });

  it('leaves the real markdown source with nothing to say', () => {
    expect(markdownWorkSource.reasonToHold(runIn('/repo', 'any'))).toBeNull();
  });
});

describe('where a hold shows on the run', () => {
  beforeEach(() => sourceReasons.clear());
  const run = (patch: Partial<PlanQueueRun> = {}): PlanQueueRun => ({ id: 'held', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans',
    workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null,
    startedAt: 1, endedAt: null, ...patch });
  const dto = (value: PlanQueueRun) => runToDto(value, [], undefined, new Map(), new Map());

  it("shows the source's reason where the run's own hold shows, for the page, the MCP status tool and the phone alike", () => {
    sourceReasons.set('held', REASON);
    expect(dto(run()).holdReason).toBe(REASON);
  });

  it("shows the run's own hold text first", () => {
    sourceReasons.set('held', REASON);
    expect(dto(run({ holdReason: 'Three jobs failed the same way.' })).holdReason).toBe('Three jobs failed the same way.');
  });

  it('shows nothing for a markdown run, or for a run that is not running', () => {
    expect(dto(run({ id: 'plain' })).holdReason).toBeNull();
    sourceReasons.set('held', REASON);
    expect(dto(run({ status: 'paused' })).holdReason).toBeNull();
    expect(dto(run({ status: 'completed', endedAt: 2 })).holdReason).toBeNull();
  });
});
