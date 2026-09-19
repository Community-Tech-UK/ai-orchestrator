import { describe, expect, it, vi } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import type { LoopCheckpoint } from './loop-checkpoint';
import { resumeLoopRun } from './loop-resume';

function loopState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'paused',
    endedAt: null,
    ...overrides,
  } as unknown as LoopState;
}

function checkpointFor(state: LoopState): LoopCheckpoint {
  return {
    version: 1,
    loopRunId: state.id,
    chatId: state.chatId,
    status: state.status,
    state,
    historyTail: [],
    convergenceNote: null,
    planRegenerationCount: 0,
    pendingContextReset: false,
    updatedAt: 1,
  };
}

function coordinatorStub(states: Map<string, LoopState>) {
  return {
    resumeLoop: vi.fn((id: string) => {
      const state = states.get(id);
      if (!state) return false;
      if (state.status !== 'paused'
        && !(state.status === 'provider-limit' && state.endedAt == null)) {
        return false;
      }
      state.status = 'running';
      return true;
    }),
    getLoop: vi.fn((id: string) => states.get(id)),
    restoreLoopFromCheckpoint: vi.fn(async (checkpoint: LoopCheckpoint) => {
      states.set(checkpoint.loopRunId, checkpoint.state);
      return checkpoint.state;
    }),
  };
}

function storeStub(checkpoints: Record<string, LoopCheckpoint> = {}) {
  return {
    getCheckpoint: vi.fn((id: string) => checkpoints[id] ?? null),
    upsertRun: vi.fn(),
  };
}

describe('resumeLoopRun', () => {
  it('resumes a live paused loop without touching the checkpoint table', async () => {
    const states = new Map([['loop-1', loopState()]]);
    const coordinator = coordinatorStub(states);
    const store = storeStub();

    const outcome = await resumeLoopRun(coordinator, store, 'loop-1');

    expect(outcome).toMatchObject({ ok: true, restoredFromCheckpoint: false });
    expect(outcome.state?.status).toBe('running');
    expect(store.getCheckpoint).not.toHaveBeenCalled();
    expect(store.upsertRun).toHaveBeenCalledWith(outcome.state);
  });

  it('re-hydrates a parked provider-limit loop from its checkpoint after a restart', async () => {
    const parked = loopState({ id: 'loop-2', status: 'provider-limit', endedAt: null });
    const coordinator = coordinatorStub(new Map());
    const store = storeStub({ 'loop-2': checkpointFor(parked) });

    const outcome = await resumeLoopRun(coordinator, store, 'loop-2');

    expect(outcome).toMatchObject({ ok: true, restoredFromCheckpoint: true });
    expect(coordinator.restoreLoopFromCheckpoint).toHaveBeenCalledTimes(1);
    expect(outcome.state?.status).toBe('running');
  });

  it('reports a missing loop instead of throwing', async () => {
    const coordinator = coordinatorStub(new Map());
    const store = storeStub();

    const outcome = await resumeLoopRun(coordinator, store, 'loop-missing');

    expect(outcome.ok).toBe(false);
    expect(outcome.restoredFromCheckpoint).toBe(false);
    expect(outcome.reason).toContain('no stored checkpoint');
  });

  it('explains why a terminal loop cannot resume', async () => {
    const states = new Map([['loop-3', loopState({ id: 'loop-3', status: 'cap-reached', endedAt: 10 })]]);
    const coordinator = coordinatorStub(states);

    const outcome = await resumeLoopRun(coordinator, storeStub(), 'loop-3');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('cap-reached');
  });

  it('calls out a terminal provider-limit loop specifically', async () => {
    const states = new Map([
      ['loop-4', loopState({ id: 'loop-4', status: 'provider-limit', endedAt: 99 })],
    ]);
    const coordinator = coordinatorStub(states);

    const outcome = await resumeLoopRun(coordinator, storeStub(), 'loop-4');

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('no resume window');
  });

  it('propagates a restore failure rather than reporting "not resumable"', async () => {
    const parked = loopState({ id: 'loop-5', status: 'paused' });
    const coordinator = coordinatorStub(new Map());
    coordinator.restoreLoopFromCheckpoint.mockRejectedValueOnce(
      new Error('isolateLoopWorkspaces: worktree missing on restore (fail-closed)'),
    );
    const store = storeStub({ 'loop-5': checkpointFor(parked) });

    await expect(resumeLoopRun(coordinator, store, 'loop-5'))
      .rejects.toThrow(/worktree missing on restore/);
  });

  it('still reports success when persisting the resumed run fails', async () => {
    const states = new Map([['loop-6', loopState({ id: 'loop-6' })]]);
    const coordinator = coordinatorStub(states);
    const store = storeStub();
    store.upsertRun.mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(resumeLoopRun(coordinator, store, 'loop-6'))
      .resolves.toMatchObject({ ok: true });
  });
});
