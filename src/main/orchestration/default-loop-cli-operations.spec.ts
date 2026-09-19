import { describe, expect, it, vi } from 'vitest';
import type { LoopRunSummary, LoopState } from '../../shared/types/loop.types';
import type { LoopCliListResult, LoopCliResumeResult } from '../mcp/loop-cli-contracts';
import type { LoopCheckpoint } from './loop-checkpoint';
import { createLoopCliOperations } from './default-loop-cli-operations';

vi.mock('./loop-coordinator', () => ({ getLoopCoordinator: vi.fn() }));
vi.mock('./loop-store', () => ({ getLoopStore: vi.fn() }));

function run(overrides: Partial<LoopRunSummary> = {}): LoopRunSummary {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'provider-limit',
    totalIterations: 3,
    totalTokens: 0,
    totalCostCents: 0,
    startedAt: 1_700_000_000_000,
    endedAt: null,
    endReason: 'Parked on a recorded provider limit',
    workspaceCwd: '/repo',
    initialPrompt: 'Work through all the livetests.',
    iterationPrompt: null,
    ...overrides,
  } as LoopRunSummary;
}

function checkpointFor(id: string, status: LoopState['status']): LoopCheckpoint {
  return {
    version: 1,
    loopRunId: id,
    chatId: 'chat-1',
    status,
    state: { id, chatId: 'chat-1', status, endedAt: null } as unknown as LoopState,
    historyTail: [],
    convergenceNote: null,
    planRegenerationCount: 0,
    pendingContextReset: false,
    updatedAt: 1,
  };
}

interface Harness {
  runs: LoopRunSummary[];
  checkpoints: Record<string, LoopCheckpoint>;
  liveStates: LoopState[];
  resumeResult?: boolean;
}

function operationsFor(harness: Harness) {
  const states = new Map(harness.liveStates.map((state) => [state.id, state]));
  const coordinator = {
    resumeLoop: vi.fn((id: string) => {
      const state = states.get(id);
      if (!state) return false;
      if (harness.resumeResult === false) return false;
      state.status = 'running';
      return true;
    }),
    getLoop: vi.fn((id: string) => states.get(id)),
    restoreLoopFromCheckpoint: vi.fn(async (checkpoint: LoopCheckpoint) => {
      states.set(checkpoint.loopRunId, checkpoint.state);
      return checkpoint.state;
    }),
    getActiveLoops: vi.fn(() => [...states.values()]),
  };
  const store = {
    listRuns: vi.fn(() => harness.runs),
    getCheckpoint: vi.fn((id: string) => harness.checkpoints[id] ?? null),
    upsertRun: vi.fn(),
  };
  const operations = createLoopCliOperations({
    getCoordinator: () => coordinator,
    getStore: () => store,
  });
  return { operations, coordinator, store };
}

describe('loop CLI operations — list', () => {
  it('returns only resumable runs by default and attaches the resume command inputs', () => {
    const { operations, store } = operationsFor({
      runs: [
        run(),
        run({ id: 'loop-done', status: 'completed', endedAt: 2, endReason: 'done' }),
        run({ id: 'loop-terminal-limit', status: 'provider-limit', endedAt: 5 }),
      ],
      checkpoints: { 'loop-1': checkpointFor('loop-1', 'provider-limit') },
      liveStates: [],
    });

    const result = operations.list({ all: false, limit: 50 }) as LoopCliListResult;

    expect(result.count).toBe(1);
    expect(result.runs[0]).toMatchObject({
      loopRunId: 'loop-1',
      resumable: true,
      live: false,
      checkpointAvailable: true,
    });
    // A terminal run must never cost a checkpoint lookup.
    expect(store.getCheckpoint).not.toHaveBeenCalledWith('loop-done');
  });

  it('marks a parked run with no checkpoint as not resumable', () => {
    const { operations } = operationsFor({
      runs: [run()],
      checkpoints: {},
      liveStates: [],
    });

    const result = operations.list({ all: false, limit: 50 }) as LoopCliListResult;

    expect(result.count).toBe(0);
  });

  it('treats a live parked loop as resumable without a stored checkpoint', () => {
    const live = { id: 'loop-1', chatId: 'chat-1', status: 'paused', endedAt: null } as unknown as LoopState;
    const { operations } = operationsFor({
      runs: [run({ status: 'paused' })],
      checkpoints: {},
      liveStates: [live],
    });

    const result = operations.list({ all: false, limit: 50 }) as LoopCliListResult;

    expect(result.runs[0]).toMatchObject({ live: true, checkpointAvailable: false, resumable: true });
  });

  it('includes terminal runs under --all and honours the limit', () => {
    const { operations, store } = operationsFor({
      runs: [
        run({ id: 'a', status: 'completed', endedAt: 2 }),
        run({ id: 'b', status: 'cancelled', endedAt: 3 }),
      ],
      checkpoints: {},
      liveStates: [],
    });

    const result = operations.list({ all: true, limit: 1 }) as LoopCliListResult;

    expect(store.listRuns).toHaveBeenCalledWith(1);
    expect(result.count).toBe(1);
    expect(result.runs[0]).toMatchObject({ loopRunId: 'a', resumable: false });
  });

  it('scans the full store window when filtering so an old parked run is not crowded out', () => {
    const { operations, store } = operationsFor({ runs: [run()], checkpoints: {}, liveStates: [] });

    operations.list({ all: false, limit: 5 });

    expect(store.listRuns).toHaveBeenCalledWith(200);
  });

  it('collapses whitespace and truncates a long goal', () => {
    const { operations } = operationsFor({
      runs: [run({ initialPrompt: `${'x'.repeat(400)}\n\nmore` })],
      checkpoints: { 'loop-1': checkpointFor('loop-1', 'provider-limit') },
      liveStates: [],
    });

    const result = operations.list({ all: false, limit: 50 }) as LoopCliListResult;

    expect(result.runs[0]!.goal).toHaveLength(200);
    expect(result.runs[0]!.goal.endsWith('…')).toBe(true);
  });
});

describe('loop CLI operations — resume', () => {
  it('restores a parked run from its checkpoint and reports the transition', async () => {
    const { operations, coordinator } = operationsFor({
      runs: [run()],
      checkpoints: { 'loop-1': checkpointFor('loop-1', 'provider-limit') },
      liveStates: [],
    });

    const result = await operations.resume({ loopRunId: 'loop-1' }) as LoopCliResumeResult;

    expect(coordinator.restoreLoopFromCheckpoint).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      loopRunId: 'loop-1',
      resumed: true,
      status: 'running',
      previousStatus: 'provider-limit',
      restoredFromCheckpoint: true,
    });
  });

  it('reports the live status as the previous status when the loop is still in memory', async () => {
    const live = { id: 'loop-1', chatId: 'chat-1', status: 'paused', endedAt: null } as unknown as LoopState;
    const { operations } = operationsFor({ runs: [run()], checkpoints: {}, liveStates: [live] });

    const result = await operations.resume({ loopRunId: 'loop-1' }) as LoopCliResumeResult;

    expect(result).toMatchObject({ previousStatus: 'paused', restoredFromCheckpoint: false });
  });

  it('throws the refusal reason for an unknown loop', async () => {
    const { operations } = operationsFor({ runs: [], checkpoints: {}, liveStates: [] });

    await expect(operations.resume({ loopRunId: 'loop-nope' }))
      .rejects.toThrow(/no stored checkpoint exists/);
  });

  it('throws the refusal reason when the coordinator declines the resume', async () => {
    const live = { id: 'loop-1', chatId: 'chat-1', status: 'cap-reached', endedAt: 9 } as unknown as LoopState;
    const { operations } = operationsFor({
      runs: [run()],
      checkpoints: {},
      liveStates: [live],
      resumeResult: false,
    });

    await expect(operations.resume({ loopRunId: 'loop-1' }))
      .rejects.toThrow(/cap-reached, which is terminal/);
  });
});
