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

  it('defers a complete intent from an intervention-consuming iteration', async () => {
    const iterationComplete = waitForEvent(coordinator, 'loop:iteration-complete');
    let completed = false;
    coordinator.once('loop:completed', () => { completed = true; });
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
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    await iterationComplete;
    const live = coordinator.getLoop(state.id);
    expect(live?.terminalIntentPending).toBeUndefined();
    expect(live?.terminalIntentHistory).toEqual([
      expect.objectContaining({
        kind: 'complete',
        status: 'deferred',
        statusReason: 'Completion intent was declared in an intervention-consuming iteration',
      }),
    ]);
    expect(completed).toBe(false);
    await coordinator.cancelLoop(state.id);
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
    });

    await paused;
    expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    expect(existsSync(join(workspace, 'BLOCKED.md'))).toBe(false);
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
    });

    await paused;
    expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    expect(archiveFailures).toEqual([]);
  });
});

function waitForEvent<T = unknown>(coordinator: LoopCoordinator, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    coordinator.once(eventName, (payload) => resolve(payload as T));
  });
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
