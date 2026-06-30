import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { runLoopControlCli } from './loop-control-cli';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-terminal-intents-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator terminal intents', () => {
  it('pauses instead of continuing when a complete intent has no configured verify command', async () => {
    const claimedFailed = waitForEvent<{ signal: string; failure: string }>(
      coordinator,
      'loop:claimed-done-but-failed',
    );
    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'verified manually'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete after manual checks'));
    });

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-complete-no-verify', {
        initialPrompt: 'do thing',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 5 },
        completion: {
          ...defaultLoopConfig(workspace, 'x').completion,
          verifyCommand: '',
          runVerifyTwice: false,
          requireCompletedFileRename: false,
          crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
        },
      });

      await expect(claimedFailed).resolves.toMatchObject({
        signal: 'declared-complete',
        failure: expect.stringContaining('no verify command is configured'),
      });
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'paused');
      expect(coordinator.getLoop(state.id)?.terminalIntentHistory).toEqual([
        expect.objectContaining({
          kind: 'complete',
          status: 'rejected',
          statusReason: 'completion not verified — no verify command configured and fresh-eyes review is not enabled',
        }),
      ]);
      expect(invokeCount).toBe(1);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  });

  it('rejects a complete intent with the REVIEW-failed reason (not "no verify command") when the fresh-eyes review produced no verdict', async () => {
    // Reproduces the reported scenario: a no-verify loop whose completion
    // authority is the fresh-eyes review. The review RAN but every reviewer
    // returned unparseable output (empty reviewersUsed). The operator-facing
    // rejection must blame the failed review, NOT a missing verify command.
    coordinator.setFreshEyesReviewer(async () => ({
      findings: [],
      reviewersUsed: [],
      summary: 'No reviewers available for headless review.',
      infrastructureError: 'cursor: Reviewer returned unparseable output; gemini: Reviewer returned unparseable output',
    }));

    const claimedFailed = waitForEvent<{ signal: string; failure: string }>(
      coordinator,
      'loop:claimed-done-but-failed',
    );
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'implemented everything'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete'));
    });

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-complete-review-errored', {
        initialPrompt: 'do thing',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 5 },
        completion: {
          ...defaultLoopConfig(workspace, 'x').completion,
          verifyCommand: '',
          runVerifyTwice: false,
          requireCompletedFileRename: false,
          crossModelReview: { enabled: true, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
        },
      });

      const failed = await claimedFailed;
      expect(failed.signal).toBe('declared-complete');
      expect(failed.failure).toContain('fresh-eyes review');
      expect(failed.failure).not.toContain('fresh-eyes review is not enabled');

      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'paused');
      expect(coordinator.getLoop(state.id)?.terminalIntentHistory).toEqual([
        expect.objectContaining({
          kind: 'complete',
          status: 'rejected',
          statusReason: expect.stringContaining('could not produce a verdict'),
        }),
      ]);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  });

  it('accepts a complete intent even when the provider callback reports an error, then still runs verify', async () => {
    const completed = waitForEvent<{ signal: string }>(coordinator, 'loop:completed');
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'all implementation work is complete'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback({ error: 'Claude CLI exited with code 1' });
    });

    await coordinator.startLoop('chat-complete-intent', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    await expect(completed).resolves.toMatchObject({ signal: 'declared-complete' });
  });

  it('marks the loop failed from a fail intent without mapping it to provider error', async () => {
    const failed = waitForEvent<{ reason: string }>(coordinator, 'loop:failed');
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'fail', '--summary', 'cannot satisfy acceptance criteria'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback({ error: 'provider exited after failure declaration' });
    });

    const state = await coordinator.startLoop('chat-fail-intent', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
      },
    });

    await expect(failed).resolves.toMatchObject({ reason: 'cannot satisfy acceptance criteria' });
    expect(coordinator.getLoop(state.id)?.status).toBe('failed');
  });

  it('imports a fail intent at the next pre-iteration boundary before spawning again', async () => {
    const failed = waitForEvent<{ reason: string }>(coordinator, 'loop:failed');
    let loopControlEnv: NodeJS.ProcessEnv | undefined;
    let invokeCount = 0;
    const intentWritten = new Promise<void>((resolve, reject) => {
      coordinator.on('loop:iteration-complete', ({ seq }: { seq: number }) => {
        if (seq !== 0 || !loopControlEnv) return;
        void runLoopControlCli(
          ['node', 'aio-loop-control', 'fail', '--summary', 'preflight failure declaration'],
          loopControlEnv,
          silentIo(),
        ).then((code) => {
          expect(code).toBe(0);
          resolve();
        }).catch(reject);
      });
    });

    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      loopControlEnv = p.loopControlEnv;
      invokeCount += 1;
      p.callback(iterationResult('first iteration completed'));
    });

    const state = await coordinator.startLoop('chat-preflight-fail-intent', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
    });

    await intentWritten;
    await expect(failed).resolves.toMatchObject({ reason: 'preflight failure declaration' });
    expect(coordinator.getLoop(state.id)?.status).toBe('failed');
    expect(invokeCount).toBe(1);
  });

  it('accepts a complete intent from an intervention-consuming iteration when verify passes', async () => {
    const completed = waitForEvent<{ signal: string }>(coordinator, 'loop:completed', 1000);
    coordinator.on('loop:started', ({ loopRunId }: { loopRunId: string }) => {
      expect(coordinator.intervene(loopRunId, 'operator correction')).toBe(true);
    });
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'complete after intervention'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete after applying intervention'));
    });

    const state = await coordinator.startLoop('chat-deferred-complete-intent', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    await expect(completed).resolves.toMatchObject({ signal: 'declared-complete' });
    await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'completed');
    expect(coordinator.getLoop(state.id)?.terminalIntentHistory).toEqual([
      expect.objectContaining({
        kind: 'complete',
        status: 'accepted',
        statusReason: 'completion accepted via declared-complete',
      }),
    ]);
  });

  it('pushes verify failure output into the next pending intervention', async () => {
    const claimedFailed = waitForEvent<{ failure: string }>(
      coordinator,
      'loop:claimed-done-but-failed',
      1000,
    );
    const iterationComplete = waitForEvent(coordinator, 'loop:iteration-complete', 1000);
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'all done'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete'));
    });

    const state = await coordinator.startLoop('chat-verify-failed-feedback', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: `"${process.execPath}" -e "console.error('first verify failed'); process.exit(1)"`,
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await expect(claimedFailed).resolves.toMatchObject({
        failure: expect.stringContaining('first verify failed'),
      });
      await iterationComplete;
      expect(coordinator.getLoop(state.id)?.pendingInterventions.map((item) => item.message)).toEqual([
        expect.stringContaining('first verify failed'),
      ]);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('pushes second verify failure output into the next pending intervention', async () => {
    writeFileSync(
      join(workspace, 'verify-second.js'),
      [
        "const fs = require('node:fs');",
        "const p = 'verify-count.txt';",
        "const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0;",
        "fs.writeFileSync(p, String(n + 1));",
        'if (n === 0) process.exit(0);',
        "console.error('second verify failed');",
        'process.exit(1);',
      ].join('\n'),
    );
    const claimedFailed = waitForEvent<{ failure: string }>(
      coordinator,
      'loop:claimed-done-but-failed',
      1000,
    );
    const iterationComplete = waitForEvent(coordinator, 'loop:iteration-complete', 1000);
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'all done'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete'));
    });

    const state = await coordinator.startLoop('chat-second-verify-failed-feedback', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: `"${process.execPath}" verify-second.js`,
        runVerifyTwice: true,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await expect(claimedFailed).resolves.toMatchObject({
        failure: expect.stringContaining('second verify failed'),
      });
      await iterationComplete;
      expect(coordinator.getLoop(state.id)?.pendingInterventions.map((item) => item.message)).toEqual([
        expect.stringContaining('second verify failed'),
      ]);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('pushes completed-file rename gate failure into the next pending intervention', async () => {
    const claimedFailed = waitForEvent<{ failure: string }>(
      coordinator,
      'loop:claimed-done-but-failed',
      1000,
    );
    const iterationComplete = waitForEvent(coordinator, 'loop:iteration-complete', 1000);
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'complete', '--summary', 'all done'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('declared complete'));
    });

    const state = await coordinator.startLoop('chat-rename-gate-feedback', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        runVerifyTwice: false,
        requireCompletedFileRename: true,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await expect(claimedFailed).resolves.toMatchObject({
        failure: expect.stringContaining('no *_Completed.md rename observed'),
      });
      await iterationComplete;
      expect(coordinator.getLoop(state.id)?.pendingInterventions.map((item) => item.message)).toEqual([
        expect.stringContaining('*_Completed.md rename'),
      ]);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('uses iterationTimeoutMs for the child invocation backstop', async () => {
    const loopError = waitForEvent<{ error: string }>(coordinator, 'loop:error', 1000);
    coordinator.on('loop:invoke-iteration', () => {
      // Intentionally never invokes the callback. The coordinator backstop
      // must use the per-iteration timeout rather than the total wall cap.
    });

    await coordinator.startLoop('chat-iteration-timeout', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1, maxWallTimeMs: 250 },
      iterationTimeoutMs: 25,
    });

    await expect(loopError).resolves.toMatchObject({
      error: expect.stringContaining('timed out after 25ms'),
    });
  });

  it('extends the child invocation backstop while matching loop activity is recent', async () => {
    const errors: string[] = [];
    const iterationComplete = waitForEvent<{ seq: number }>(coordinator, 'loop:iteration-complete', 1000);
    coordinator.on('loop:error', ({ error }: { error: string }) => errors.push(error));
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        seq: number;
        stage: string;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      setTimeout(() => {
        coordinator.emit('loop:activity', {
          loopRunId: p.loopRunId,
          seq: p.seq,
          stage: p.stage,
          timestamp: Date.now(),
          kind: 'status',
          message: 'CLI status: busy',
        });
      }, 15);
      setTimeout(() => {
        p.callback(iterationResult('finished after active timeout checkpoint'));
      }, 45);
    });

    const state = await coordinator.startLoop('chat-active-timeout-extension', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1, maxWallTimeMs: 250 },
      iterationTimeoutMs: 25,
      streamIdleTimeoutMs: 100,
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await expect(iterationComplete).resolves.toMatchObject({ seq: 0 });
      expect(errors).toEqual([]);
      expect(coordinator.getLoop(state.id)?.totalIterations).toBe(1);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('prefers a structured block intent over a simultaneous BLOCKED.md file and archives the file', async () => {
    const paused = waitForEvent(coordinator, 'loop:paused-no-progress');
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      writeFileSync(join(workspace, 'BLOCKED.md'), 'raw blocker\n');
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'block', '--summary', 'need operator decision'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback({
        childInstanceId: null,
        output: 'blocked',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });

    const state = await coordinator.startLoop('chat-block-intent', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      blockSanityProbe: { enabled: false },
    });

    await paused;
    expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    expect(existsSync(join(workspace, 'BLOCKED.md'))).toBe(false);
  });

  it('FU-2: marks the loop manual-review-only when no verifyCommand is configured', async () => {
    const state = await coordinator.startLoop('chat-manual-review', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: '',
        // crossModelReview off so no plan-file workspace state interferes.
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });
    try {
      expect(state.manualReviewOnly).toBe(true);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('FU-2: does NOT mark manual-review-only when a verifyCommand is configured', async () => {
    const state = await coordinator.startLoop('chat-not-manual-review', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });
    try {
      expect(state.manualReviewOnly).toBe(false);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('FU-8: cancelLoop awaits the registered adapter-cleanup hook', async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupStarted = new Promise<string>((resolve) => {
      coordinator.setAdapterCleanupHook(async (loopRunId: string) => {
        resolve(loopRunId);
        await new Promise<void>((r) => { resolveCleanup = r; });
      });
    });
    coordinator.on('loop:invoke-iteration', () => {
      // Never callback — hold the iteration so cancellation is mid-flight.
    });

    const state = await coordinator.startLoop('chat-cleanup-hook', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1, maxWallTimeMs: 60_000 },
      iterationTimeoutMs: 60_000,
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    let cancelDone = false;
    const cancelPromise = coordinator.cancelLoop(state.id).then((ok) => {
      cancelDone = true;
      return ok;
    });

    // The hook must be entered (cancelLoop has called terminate, which
    // invoked the hook), but cancelLoop must NOT have resolved yet — it's
    // awaiting our hook's still-unresolved promise.
    await expect(cleanupStarted).resolves.toBe(state.id);
    expect(cancelDone).toBe(false);

    // Resolve the hook; cancelLoop should now resolve.
    resolveCleanup!();
    await expect(cancelPromise).resolves.toBe(true);
  });

  it('treats a missing BLOCKED.md at archive time as benign (operator deleted manually) — no error event', async () => {
    const paused = waitForEvent(coordinator, 'loop:paused-no-progress');
    const archiveFailures: unknown[] = [];
    coordinator.on('loop:claimed-done-but-failed', (data) => archiveFailures.push(data));

    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      // Note: this iteration does NOT write BLOCKED.md before declaring
      // the block intent. The structured block intent path runs, the
      // archive helper finds no BLOCKED.md to move (ENOENT), and the
      // coordinator must treat that as a debug-level no-op — not a
      // claimed-done-but-failed event.
      const code = await runLoopControlCli(
        ['node', 'aio-loop-control', 'block', '--summary', 'need operator decision'],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback({
        childInstanceId: null,
        output: 'blocked',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });

    const state = await coordinator.startLoop('chat-block-no-file', {
      initialPrompt: 'do thing',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
      blockSanityProbe: { enabled: false },
    });

    await paused;
    expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    expect(archiveFailures).toEqual([]);
  });
});

function waitForEvent<T = unknown>(
  coordinator: LoopCoordinator,
  eventName: string,
  timeoutMs?: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    const onEvent = (payload: unknown) => {
      if (timeout) clearTimeout(timeout);
      resolve(payload as T);
    };
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        coordinator.off(eventName, onEvent);
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
    }
    coordinator.once(eventName, onEvent);
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 750): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
}

function silentIo() {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
}

function iterationResult(output: string): LoopChildResult {
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
  };
}
