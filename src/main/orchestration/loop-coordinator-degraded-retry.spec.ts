import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import type { ProviderLimitResumeScheduler } from './loop-coordinator.types';
import { runLoopControlCli } from './loop-control-cli';
import { CompletedFileWatcher } from './loop-completion-detector';
import { classifyDegradedIteration } from './loop-coordinator-block-utils';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-degraded-retry-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-degraded-retry"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});


/** WS5: evidence the REAL invoker attaches when its workspace observers
 * completed and saw no delta — the only state that permits an automatic replay. */
const noneObservedEvidence = {
  outcome: 'failed' as const,
  outputExcerpt: 'boom',
  workspaceEffect: 'none-observed' as const,
  filesChanged: [],
  providerThreadReusable: false,
};

describe('LoopCoordinator degraded iteration retry', () => {
  it('retries transient invocation errors for the same seq and proceeds without terminating as error', async () => {
    let invokeCount = 0;
    const seqs: number[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        seq: number;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      seqs.push(p.seq);
      if (invokeCount === 1) {
        // WS5: the real invoker attaches workspace-effect evidence; a proven
        // no-write failure is the retryable case.
        p.callback({ error: 'boom', attemptEvidence: noneObservedEvidence } as never);
        return;
      }
      p.callback(iterationResult(`recovered-attempt-${invokeCount}`));
    });

    const state = await coordinator.startLoop('chat-degraded-invocation-error', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 5000);
      await waitForCondition(() => coordinator.getLoop(state.id)?.status !== 'running', 5000);
      expect(invokeCount).toBeGreaterThanOrEqual(2);
      expect(seqs[0]).toBe(0);
      expect(seqs[1]).toBe(0);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('retries a void iteration before seq advances', async () => {
    let invokeCount = 0;
    const seqs: number[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        seq: number;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      seqs.push(p.seq);
      if (invokeCount === 1) {
        p.callback(iterationResult(''));
        return;
      }
      p.callback(iterationResult('real work happened'));
    });

    const state = await coordinator.startLoop('chat-degraded-void-iteration', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 5000);
      await waitForCondition(() => coordinator.getLoop(state.id)?.status !== 'running', 5000);
      expect(seqs[0]).toBe(0);
      expect(seqs[1]).toBe(0);
      expect(invokeCount).toBeGreaterThanOrEqual(2);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('does not retry when degraded-iteration retry is disabled', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      p.callback({ error: 'boom' });
    });

    const state = await coordinator.startLoop('chat-degraded-disabled', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      degradedIterationRetry: { enabled: false, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'error', 5000);
      expect(invokeCount).toBe(1);
      expect(coordinator.getLoop(state.id)?.status).toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('parks structured rate-limit invocation errors before degraded retry', async () => {
    let invokeCount = 0;
    const scheduler = vi.fn<ProviderLimitResumeScheduler>(() => () => { /* noop */ });
    const providerLimitEvents: unknown[] = [];
    coordinator.setProviderLimitResumeScheduler(scheduler);
    coordinator.on('loop:provider-limit', (event) => providerLimitEvents.push(event));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      p.callback({
        error: 'Too many requests',
        status: 429,
        headers: { 'retry-after': '60' },
        body: { error: { message: 'Rate limit exceeded; retry later.' } },
      } as never);
    });

    const startedAt = Date.now();
    const state = await coordinator.startLoop('chat-structured-rate-limit', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      provider: 'claude',
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'provider-limit', 5000);
      const parked = coordinator.getLoop(state.id);
      expect(invokeCount).toBe(1);
      expect(parked).toMatchObject({
        status: 'provider-limit',
        endedAt: null,
      });
      expect(parked?.endReason).toContain('rate_limit');
      expect(providerLimitEvents[0]).toMatchObject({
        source: 'quota',
        action: 'throttle',
        willResume: true,
      });
      expect(scheduler).toHaveBeenCalledWith(expect.objectContaining({
        loopRunId: state.id,
        provider: 'claude',
        source: 'quota',
        action: 'throttle',
        resumeAt: expect.any(Number),
      }));
      expect(scheduler.mock.calls[0]?.[0].resumeAt).toBeGreaterThanOrEqual(startedAt + 60_000);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('uses classification to run one fresh-context retry for context overflow even when degraded retry is disabled', async () => {
    let invokeCount = 0;
    const forceContextResets: boolean[] = [];
    const contextWindowTokens: (number | undefined)[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        forceContextReset?: boolean;
        contextWindowTokens?: number;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      forceContextResets.push(p.forceContextReset === true);
      contextWindowTokens.push(p.contextWindowTokens);
      if (invokeCount === 1) {
        p.callback({
          error: 'Request too large',
          status: 400,
          attemptEvidence: noneObservedEvidence,
          model: 'claude-default-current',
          body: {
            error: {
              message: "This model's maximum context length is 1000000 tokens. Your request used 1100001 tokens.",
            },
          },
        } as never);
        return;
      }
      p.callback(iterationResult('recovered after context reset'));
    });

    const state = await coordinator.startLoop('chat-context-overflow-routing', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      degradedIterationRetry: { enabled: false, maxRetries: 0 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 5000);
      expect(forceContextResets).toEqual([false, true]);
      expect(contextWindowTokens).toEqual([undefined, 1_000_000]);
      const calibration = (coordinator.getLoop(state.id) as {
        contextWindowCalibration?: { model?: string; windowTokens: number };
      } | undefined)?.contextWindowCalibration;
      expect(calibration).toMatchObject({
        model: 'claude-default-current',
        windowTokens: 1_000_000,
      });
      expect(coordinator.getLoop(state.id)?.status).not.toBe('error');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('does not fall back to degraded retry when context-overflow recovery also fails', async () => {
    let invokeCount = 0;
    const forceContextResets: boolean[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        forceContextReset?: boolean;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      forceContextResets.push(p.forceContextReset === true);
      p.callback({
        error: 'Request too large',
        status: 400,
        attemptEvidence: noneObservedEvidence,
        body: {
          error: {
            message: "This model's maximum context length is 200000 tokens. Your request used 220001 tokens.",
          },
        },
      } as never);
    });

    const state = await coordinator.startLoop('chat-context-overflow-no-generic-retry', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'error', 5000);
      expect(invokeCount).toBe(2);
      expect(forceContextResets).toEqual([false, true]);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('does not retry over a pending terminal intent and pauses on block intent', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'block', '--summary', 'operator intervention required'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback({ error: 'boom' });
    });

    const state = await coordinator.startLoop('chat-degraded-terminal-intent', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 2 },
      blockSanityProbe: { enabled: false },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'paused', 5000);
      expect(invokeCount).toBe(1);
      expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('classifies degraded iterations correctly', () => {
    expect(classifyDegradedIteration(null, 'boom')).toBe('invocation-error');
    expect(classifyDegradedIteration(null, null)).toBeNull();
    expect(classifyDegradedIteration(iterationResult(''), null)).toBe('void-iteration');
    expect(classifyDegradedIteration(iterationResult('output'), null)).toBeNull();
    expect(
      classifyDegradedIteration(
        iterationResult('', {
          toolCalls: [{ toolName: 'Read', argsHash: 'abc', success: true, durationMs: 1 }],
        }),
        null,
      ),
    ).toBeNull();
  });

  it('WS5: a degraded attempt that already WROTE into the workspace pauses for review, never replays', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      p.callback({
        error: 'stream cut mid-write',
        attemptEvidence: {
          outcome: 'failed',
          outputExcerpt: 'partial',
          workspaceEffect: 'writes-observed',
          filesChanged: [{ path: 'src/half-written.ts', additions: 12, deletions: 0, contentHash: 'h1' }],
          providerThreadReusable: false,
        },
      } as never);
    });

    const state = await coordinator.startLoop('chat-ws5-writes-observed', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'completed-needs-review', 5000);
      // NO replay happened — the writes-observed attempt sealed the run.
      expect(invokeCount).toBe(1);
      const final = coordinator.getLoop(state.id);
      expect(final?.endReason).toContain('double-apply');
      expect(final?.endEvidence?.['workspaceEffect']).toBe('writes-observed');
      expect(final?.endEvidence?.['changedPaths']).toEqual(['src/half-written.ts']);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('WS5: an evidence-less failure (hung-CLI timeout shape) has UNKNOWN workspace state and pauses for review', async () => {
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      invokeCount += 1;
      // Bare error without attemptEvidence — the shape of a throw that
      // bypassed the invoker's observers entirely.
      p.callback({ error: 'boom' });
    });

    const state = await coordinator.startLoop('chat-ws5-unknown-effect', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      degradedIterationRetry: { enabled: true, maxRetries: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'completed-needs-review', 5000);
      expect(invokeCount).toBe(1);
      const final = coordinator.getLoop(state.id);
      expect(final?.endReason).toContain('UNPROVABLE');
      expect(final?.endEvidence?.['workspaceEffect']).toBe('unknown');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition was not met before timeout');
}

function silentIo() {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
}

function iterationResult(output: string, overrides?: Partial<LoopChildResult>): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
    ...overrides,
  };
}
