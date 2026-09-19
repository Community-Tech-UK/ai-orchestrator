import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService, type PlanQueueStateChangedPush } from '../services/ipc/plan-queue-ipc.service';
import { PlanQueueStore } from './plan-queue.store';

function makeRun(overrides: Partial<PlanQueueRunDto> = {}): PlanQueueRunDto {
  return {
    id: 'run-1',
    parentInstanceId: 'inst-1',
    kind: 'plans',
    workspaceCwd: '/repo',
    status: 'running',
    config: {
      workerSlots: 3,
      verificationSlots: 2,
      maxRounds: 3,
      maxLoadAverage: 30,
      postMergeGate: [],
      verifierGates: [],
      relaxSettings: false,
    },
    workerProvider: 'claude',
    relaxedSettings: [],
    startedAt: 1,
    endedAt: null,
    items: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<PlanQueueRunDto['items'][number]> = {}): PlanQueueRunDto['items'][number] {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: 'docs/plans/foo_plan.md',
    state: 'working',
    round: 1,
    erroredRounds: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('PlanQueueStore', () => {
  let stateChangedCallback: ((event: PlanQueueStateChangedPush) => void) | null = null;
  const ipc = {
    list: vi.fn(),
    get: vi.fn(),
    alerts: vi.fn(),
    diffstat: vi.fn(),
    start: vi.fn(),
    answer: vi.fn(),
    control: vi.fn(),
    onStateChanged: vi.fn((cb: (event: PlanQueueStateChangedPush) => void) => {
      stateChangedCallback = cb;
      return () => undefined;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateChangedCallback = null;
    ipc.list.mockResolvedValue({ success: true, data: { runs: [makeRun()], alerts: [] } });
    TestBed.configureTestingModule({
      providers: [PlanQueueStore, { provide: PlanQueueIpcService, useValue: ipc }],
    });
  });

  it('loads runs and alerts', async () => {
    const store = TestBed.inject(PlanQueueStore);
    await store.load();
    expect(store.allRuns()).toHaveLength(1);
    expect(store.isLoading()).toBe(false);
    expect(store.lastError()).toBeNull();
  });

  it('surfaces an error when the list call fails', async () => {
    ipc.list.mockResolvedValue({ success: false, error: { message: 'boom' } });
    const store = TestBed.inject(PlanQueueStore);
    await store.load();
    expect(store.lastError()).toBe('boom');
    expect(store.allRuns()).toHaveLength(0);
  });

  it('replaces the matching run in place on a state-changed push', async () => {
    const store = TestBed.inject(PlanQueueStore);
    store.ensureWired();
    await store.load();

    stateChangedCallback?.({
      runId: 'run-1',
      run: makeRun({ status: 'paused' }),
    });

    expect(store.allRuns()).toHaveLength(1);
    expect(store.allRuns()[0].status).toBe('paused');
  });

  it('prepends an unknown run id from a state-changed push', async () => {
    const store = TestBed.inject(PlanQueueStore);
    store.ensureWired();
    await store.load();

    stateChangedCallback?.({ runId: 'run-2', run: makeRun({ id: 'run-2' }) });

    expect(store.allRuns().map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });

  it('reloads the list when a state-changed push carries a null run', async () => {
    const store = TestBed.inject(PlanQueueStore);
    store.ensureWired();
    await store.load();
    ipc.list.mockResolvedValue({ success: true, data: { runs: [makeRun({ id: 'run-3' })], alerts: [] } });

    stateChangedCallback?.({ runId: 'run-1', run: null });
    await vi.waitFor(() => expect(store.allRuns().map((r) => r.id)).toEqual(['run-3']));
  });

  it('wires the state-changed listener only once', () => {
    const store = TestBed.inject(PlanQueueStore);
    store.ensureWired();
    store.ensureWired();
    expect(ipc.onStateChanged).toHaveBeenCalledTimes(1);
  });

  it('exposes items awaiting a triage answer across every run', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: {
        runs: [
          makeRun({
            items: [
              makeItem({ id: 'item-needs', state: 'needs-answer', question: { question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }),
              makeItem({ id: 'item-working', state: 'working' }),
              makeItem({ id: 'item-worker-asks', state: 'fixing', question: { question: 'Continue?', options: [{ id: 'continue', label: 'Carry on' }, { id: 'park', label: 'Park' }] } }),
              makeItem({ id: 'item-done', state: 'landed', question: { question: 'Stale', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] } }),
            ],
          }),
        ],
        alerts: [],
      },
    });
    const store = TestBed.inject(PlanQueueStore);
    await store.load();

    // A readiness question and a waiting worker's question both need James; a terminal item never does.
    expect(store.needsAnswerItems().map((i) => i.id)).toEqual(['item-needs', 'item-worker-asks']);
  });

  it('exposes parked items that still have a branch (a discarded one has none)', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: {
        runs: [
          makeRun({
            items: [
              makeItem({ id: 'item-parked', state: 'parked', parkReason: 'round-limit', branchName: 'queue/a-1' }),
              makeItem({ id: 'item-discarded', state: 'parked', parkReason: 'round-limit', branchName: null }),
              makeItem({ id: 'item-landed', state: 'landed' }),
            ],
          }),
        ],
        alerts: [],
      },
    });
    const store = TestBed.inject(PlanQueueStore);
    await store.load();

    expect(store.parkedItems().map((i) => i.id)).toEqual(['item-parked']);
  });

  it('collects real need-James entries from livetest runs only, and counts policy-gated ones', async () => {
    ipc.list.mockResolvedValue({
      success: true,
      data: {
        runs: [
          makeRun({
            id: 'run-livetest',
            kind: 'livetests',
            items: [
              makeItem({
                id: 'item-lt',
                runId: 'run-livetest',
                verdict: {
                  verdict: 'PASS',
                  findings: [],
                  gatesRun: [],
                  documentComplete: false,
                  needJames: [
                    { check: 'Manual UI check', classification: 'real', reason: 'Needs a rebuilt app' },
                    { check: 'Old check', classification: 'stale', reason: 'Superseded' },
                    { check: 'Restricted check', classification: 'policy-gated', reason: 'Needs approval' },
                  ],
                },
              }),
            ],
          }),
          makeRun({
            id: 'run-plans',
            kind: 'plans',
            items: [
              makeItem({
                id: 'item-plan',
                runId: 'run-plans',
                verdict: {
                  verdict: 'PASS',
                  findings: [],
                  gatesRun: [],
                  documentComplete: true,
                  needJames: [{ check: 'Should never surface', classification: 'real', reason: 'n/a' }],
                },
              }),
            ],
          }),
        ],
        alerts: [],
      },
    });
    const store = TestBed.inject(PlanQueueStore);
    await store.load();

    expect(store.needJamesReal()).toEqual([
      {
        runId: 'run-livetest',
        itemId: 'item-lt',
        documentPath: 'docs/plans/foo_plan.md',
        check: 'Manual UI check',
        reason: 'Needs a rebuilt app',
      },
    ]);
    expect(store.policyGatedCount()).toBe(1);
  });

  it('upserts the started run and returns the response', async () => {
    ipc.start.mockResolvedValue({ success: true, data: { run: makeRun({ id: 'run-new' }), excluded: [] } });
    const store = TestBed.inject(PlanQueueStore);
    await store.load();

    const res = await store.startRun({ parentInstanceId: 'inst-1', kind: 'plans', workspaceCwd: '/repo' });

    expect(res.success).toBe(true);
    expect(store.allRuns().map((r) => r.id)).toContain('run-new');
  });

  it('surfaces an error when starting a run fails', async () => {
    ipc.start.mockResolvedValue({ success: false, error: { message: 'no worker slots' } });
    const store = TestBed.inject(PlanQueueStore);

    await store.startRun({ parentInstanceId: 'inst-1', kind: 'plans', workspaceCwd: '/repo' });

    expect(store.lastError()).toBe('no worker slots');
  });

  it('surfaces an error when answering fails', async () => {
    ipc.answer.mockResolvedValue({ success: false, error: { message: 'unknown item' } });
    const store = TestBed.inject(PlanQueueStore);

    await store.answer('item-1', 'a');

    expect(ipc.answer).toHaveBeenCalledWith('item-1', 'a');
    expect(store.lastError()).toBe('unknown item');
  });

  it('sends control actions through the ipc service', async () => {
    ipc.control.mockResolvedValue({ success: true, data: null });
    const store = TestBed.inject(PlanQueueStore);

    await store.control({ action: 'cancel', runId: 'run-1' });

    expect(ipc.control).toHaveBeenCalledWith({ action: 'cancel', runId: 'run-1' });
  });

  it('returns the diffstat text on success', async () => {
    ipc.diffstat.mockResolvedValue({ success: true, data: { diffstat: '3 files changed' } });
    const store = TestBed.inject(PlanQueueStore);

    const result = await store.diffstat('item-1');

    expect(result).toBe('3 files changed');
  });

  it('returns an empty string and records an error when the diffstat call fails', async () => {
    ipc.diffstat.mockResolvedValue({ success: false, error: { message: 'no such item' } });
    const store = TestBed.inject(PlanQueueStore);

    const result = await store.diffstat('item-1');

    expect(result).toBe('');
    expect(store.lastError()).toBe('no such item');
  });

  it('refreshes reconciler alerts', async () => {
    ipc.alerts.mockResolvedValue({ success: true, data: { alerts: [{ kind: 'unowned-worktree', path: '/tmp/x' }] } });
    const store = TestBed.inject(PlanQueueStore);

    await store.refreshAlerts();

    expect(store.reconcilerAlerts()).toHaveLength(1);
  });
});
