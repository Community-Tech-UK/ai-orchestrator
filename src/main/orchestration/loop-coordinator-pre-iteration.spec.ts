import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { LoopStateSchema } from '@contracts/schemas/loop';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'claude', loopModelByProvider: {}, auxiliaryLlmRoutingClassificationEnabled: false }), get: () => undefined }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('./invocation-model-resolver', () => ({ resolveLoopChildModel: async () => 'test-model' }));

function childResult(): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'made progress',
    tokens: 1,
    filesChanged: [{ path: 'src/progress.ts', additions: 1, deletions: 0, contentHash: 'hash-1' }],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('LoopCoordinator pre-iteration persistence marker', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    workspace = mkdtempSync(join(tmpdir(), 'loop-pre-iter-'));
  });

  afterEach(async () => {
    await cleanupLoopCoordinatorSpec({ coordinator, workspace });
  }, 20_000);

  it('A3: sends full instructions at round 0 and 10, persists their sequence, and sends cards in between', async () => {
    const prompts: string[] = [];
    const anchorSeqs: number[] = [];
    let resolveLast!: () => void;
    const lastInvoked = new Promise<void>((resolve) => { resolveLast = resolve; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; prompt: string; loopRunId: string; callback(result: LoopChildResult): void };
      prompts[p.seq] = p.prompt;
      const state = coordinator.getLoop(p.loopRunId)!;
      anchorSeqs[p.seq] = state.lastFullAnchorSeq!;
      expect(LoopStateSchema.parse(JSON.parse(JSON.stringify(state))).lastFullAnchorSeq).toBe(state.lastFullAnchorSeq);
      if (p.seq === 10) { coordinator.pauseLoop(p.loopRunId); resolveLast(); }
      queueMicrotask(() => p.callback({ ...childResult(),
        output: `Changed unique module number ${p.seq} and ran its focused check ${p.seq * 19}.`,
        filesChanged: [{ path: `src/progress-${p.seq}.ts`, additions: 1, deletions: 0, contentHash: `hash-${p.seq}` }],
        threadCaps: { supportsResume: true, sameThreadContinuation: true, model: 'test-model' },
        testPassCount: p.seq + 1,
      }));
    });
    const config = defaultLoopConfig(workspace, 'Make progress across rounds');
    config.caps.maxIterations = 20;
    config.progressThresholds.stageWarnIterations.IMPLEMENT = 20;
    config.progressThresholds.stageCriticalIterations.IMPLEMENT = 20;
    config.contextStrategy = 'same-session';
    config.completion.verifyCommand = '';
    await coordinator.startLoop('chat-anchor-cadence', config);
    await lastInvoked;
    expect(prompts[0]).toContain('Goal (persistent across iterations)');
    for (let seq = 1; seq < 10; seq += 1) {
      expect(prompts[seq]).toContain('# Loop Mode — Continuation');
      expect(prompts[seq]).toContain('Goal (unchanged;');
      expect(anchorSeqs[seq]).toBe(0);
    }
    expect(prompts[10]).toContain('Goal (persistent across iterations)');
    expect(anchorSeqs[10]).toBe(10);
  }, 20_000);

  it('sets an in-flight idempotency marker before invoking the child and clears it after sealing the iteration', async () => {
    const preIterationStates: LoopState[] = [];
    coordinator.registerPreIterationHook(({ state }) => {
      preIterationStates.push(structuredClone(state));
    });

    const iterationComplete = new Promise<void>((resolve) => {
      coordinator.on('loop:iteration-complete', () => resolve());
    });
    const invoked = new Promise<void>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as {
          seq: number;
          idempotencyKey: string;
          callback: (result: LoopChildResult) => void;
        };
        expect(preIterationStates).toHaveLength(1);
        expect(preIterationStates[0].inFlightIteration).toMatchObject({
          seq: 0,
          stage: 'IMPLEMENT',
          idempotencyKey: p.idempotencyKey,
        });
        expect(p.idempotencyKey).toMatch(/:iteration:0$/);
        resolve();
        queueMicrotask(() => p.callback(childResult()));
      });
    });

    const config = defaultLoopConfig(workspace, 'make progress once');
    config.caps.maxIterations = 1;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-pre-iter', config);

    await invoked;
    await iterationComplete;

    expect(coordinator.getLoop(state.id)?.inFlightIteration).toBeUndefined();
  }, 20_000);

  it('copies invoker capture metadata into the sealed iteration record', async () => {
    const iterationComplete = new Promise<void>((resolve) => {
      coordinator.on('loop:iteration-complete', () => resolve());
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        callback: (result: LoopChildResult) => void;
      };
      queueMicrotask(() => p.callback({
        ...childResult(),
        filesRead: ['src/input.ts'],
        finishReason: 'tool_use',
        unresolvedToolCalls: true,
        toolCalls: [{
          toolName: 'Read',
          argsHash: 'args-hash',
          resultHash: 'result-hash',
          success: true,
          durationMs: 1,
        }],
      }));
    });

    const config = defaultLoopConfig(workspace, 'capture invoker metadata');
    config.caps.maxIterations = 1;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-capture-metadata', config);

    await iterationComplete;

    expect(coordinator.getLoop(state.id)?.lastIteration).toMatchObject({
      filesRead: ['src/input.ts'],
      finishReason: 'tool_use',
      unresolvedToolCalls: true,
      toolCalls: [expect.objectContaining({ resultHash: 'result-hash' })],
    });
  }, 20_000);

  it('clears the in-flight marker when an invocation exits after the loop is paused', async () => {
    const markerCleared = new Promise<void>((resolve) => {
      coordinator.on('loop:state-changed', (payload: unknown) => {
        const state = (payload as { state?: LoopState }).state;
        if (state?.status === 'paused' && state.inFlightIteration === undefined) {
          resolve();
        }
      });
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      expect(coordinator.getLoop(p.loopRunId)?.inFlightIteration).toBeDefined();
      coordinator.pauseLoop(p.loopRunId);
      queueMicrotask(() => p.callback({ error: 'parent instance interrupted' }));
    });

    const config = defaultLoopConfig(workspace, 'pause during invocation');
    config.caps.maxIterations = 1;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-pre-iter-pause', config);

    await markerCleared;

    expect(coordinator.getLoop(state.id)?.inFlightIteration).toBeUndefined();
  }, 20_000);

  it('does not invoke the child when a pre-iteration hook fails', async () => {
    coordinator.registerPreIterationHook(() => {
      throw new Error('checkpoint failed');
    });

    let invoked = false;
    const failed = new Promise<LoopState>((resolve) => {
      coordinator.on('loop:state-changed', (payload: unknown) => {
        const state = (payload as { state?: LoopState }).state;
        if (state?.status === 'error') resolve(state);
      });
    });
    coordinator.on('loop:invoke-iteration', () => {
      invoked = true;
    });

    const config = defaultLoopConfig(workspace, 'fail before invocation');
    config.caps.maxIterations = 1;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-pre-iter-fail', config);

    const errored = await failed;

    expect(invoked).toBe(false);
    expect(errored.endReason).toBe('checkpoint failed');
    expect(coordinator.getLoop(state.id)?.inFlightIteration).toBeUndefined();
  }, 20_000);

  it('stops post-iteration flow when an iteration hook terminates the loop', async () => {
    let iterationCompleteEmitted = false;
    coordinator.on('loop:iteration-complete', () => {
      iterationCompleteEmitted = true;
    });
    coordinator.registerIterationHook(({ state }) => {
      coordinator.failLoop(state.id, 'hook safety failure');
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      queueMicrotask(() => p.callback(childResult()));
    });
    const failed = new Promise<LoopState>((resolve) => {
      coordinator.on('loop:state-changed', (payload: unknown) => {
        const state = (payload as { state?: LoopState }).state;
        if (state?.status === 'failed') resolve(state);
      });
    });

    const config = defaultLoopConfig(workspace, 'fail from hook');
    config.caps.maxIterations = 2;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-hook-fail', config);
    const failedState = await failed;

    expect(failedState.id).toBe(state.id);
    expect(failedState.endReason).toBe('hook safety failure');
    expect(iterationCompleteEmitted).toBe(false);
  }, 20_000);

  it('fails closed when Phase 4 tool rw-lock conflicts are observed', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      invokeCount += 1;
      const p = payload as { callback: (result: LoopChildResult) => void };
      queueMicrotask(() => p.callback({
        ...childResult(),
        output: 'conflicting writes',
        exitedCleanly: false,
        errors: [{
          bucket: 'tool-rw-lock-conflict',
          exactHash: 'conflict-hash',
          excerpt: 'Overlapping write tools',
        }],
      }));
    });
    const failed = new Promise<LoopState>((resolve) => {
      coordinator.on('loop:state-changed', (payload: unknown) => {
        const state = (payload as { state?: LoopState }).state;
        if (state?.status === 'failed') resolve(state);
      });
    });

    const config = defaultLoopConfig(workspace, 'fail on rw conflict');
    config.caps.maxIterations = 3;
    config.completion.verifyCommand = '';
    const state = await coordinator.startLoop('chat-rw-conflict', config);
    const failedState = await failed;

    expect(failedState.id).toBe(state.id);
    expect(failedState.endReason).toContain('phase4.toolRwLocks safety violation');
    expect(failedState.lastIteration?.errors[0]?.bucket).toBe('tool-rw-lock-conflict');
    expect(invokeCount).toBe(1);
  }, 20_000);
});
