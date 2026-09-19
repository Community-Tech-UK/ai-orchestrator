import { describe, expect, it, vi } from 'vitest';
import { LOOP_CLI_METHODS, type LoopCliOperations } from './loop-cli-contracts';
import {
  dispatchLoopCliRpc,
  isLoopCliMutationMethod,
  isLoopCliRpcMethod,
} from './orchestrator-tools-rpc-loop';

const RUN = {
  loopRunId: 'loop-1',
  status: 'provider-limit',
  startedAt: 1,
  endedAt: null,
  endReason: 'parked',
  totalIterations: 0,
  workspaceCwd: '/repo',
  goal: 'do the thing',
  live: false,
  checkpointAvailable: true,
  resumable: true,
};

function operations(overrides: Partial<LoopCliOperations> = {}): LoopCliOperations {
  return {
    list: vi.fn(() => ({ count: 1, runs: [RUN] })),
    resume: vi.fn(() => ({
      loopRunId: 'loop-1',
      resumed: true,
      status: 'running',
      previousStatus: 'provider-limit',
      restoredFromCheckpoint: true,
    })),
    ...overrides,
  };
}

describe('orchestrator-tools loop RPC', () => {
  it('recognises only its own methods', () => {
    expect(isLoopCliRpcMethod(LOOP_CLI_METHODS.list)).toBe(true);
    expect(isLoopCliRpcMethod(LOOP_CLI_METHODS.resume)).toBe(true);
    expect(isLoopCliRpcMethod('orchestrator_tools.loop.cancel')).toBe(false);
    expect(isLoopCliRpcMethod('orchestrator_tools.settings.privileged_set')).toBe(false);
  });

  it('treats resume as a mutation and list as read-only', () => {
    expect(isLoopCliMutationMethod(LOOP_CLI_METHODS.resume)).toBe(true);
    expect(isLoopCliMutationMethod(LOOP_CLI_METHODS.list)).toBe(false);
  });

  it('applies payload defaults before calling the parent operations', async () => {
    const ops = operations();

    await dispatchLoopCliRpc(LOOP_CLI_METHODS.list, {}, ops);

    expect(ops.list).toHaveBeenCalledWith({ all: false, limit: 50 });
  });

  it('rejects an out-of-range limit', async () => {
    await expect(dispatchLoopCliRpc(LOOP_CLI_METHODS.list, { limit: 5000 }, operations()))
      .rejects.toThrow();
  });

  it('rejects unknown payload keys', async () => {
    await expect(
      dispatchLoopCliRpc(LOOP_CLI_METHODS.resume, { loopRunId: 'loop-1', force: true }, operations()),
    ).rejects.toThrow();
  });

  it('rejects an empty loop id', async () => {
    await expect(dispatchLoopCliRpc(LOOP_CLI_METHODS.resume, { loopRunId: '' }, operations()))
      .rejects.toThrow();
  });

  it('re-validates the operation result on the way out', async () => {
    const ops = operations({ list: vi.fn(() => ({ count: 1, runs: [{ loopRunId: 'loop-1' }] })) });

    await expect(dispatchLoopCliRpc(LOOP_CLI_METHODS.list, {}, ops)).rejects.toThrow();
  });

  it('reports unavailable operations instead of crashing the socket', async () => {
    await expect(dispatchLoopCliRpc(LOOP_CLI_METHODS.list, {}, null))
      .rejects.toThrow(/Loop CLI operations unavailable/);
  });

  it('passes a refusal from the parent through as a rejection', async () => {
    const ops = operations({
      resume: vi.fn(() => {
        throw new Error('Loop loop-1 is cap-reached, which is terminal.');
      }),
    });

    await expect(dispatchLoopCliRpc(LOOP_CLI_METHODS.resume, { loopRunId: 'loop-1' }, ops))
      .rejects.toThrow(/cap-reached/);
  });
});
