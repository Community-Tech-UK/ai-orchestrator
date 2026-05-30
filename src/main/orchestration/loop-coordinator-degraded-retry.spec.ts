import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { runLoopControlCli } from './loop-control-cli';
import { CompletedFileWatcher } from './loop-completion-detector';
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
        p.callback({ error: 'boom' });
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
    const classifyDegradedIteration = (coordinator as unknown as {
      classifyDegradedIteration: (
        childResult: LoopChildResult | null,
        invocationError: string | null,
      ) => 'invocation-error' | 'void-iteration' | null;
    }).classifyDegradedIteration.bind(coordinator);

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
