import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { runLoopControlCli } from './loop-control-cli';
import { CompletedFileWatcher } from './loop-completion-detector';
import { defaultLoopConfig, type LoopTerminalIntentEvidence } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-block-sanity-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"loop-block-sanity"}\n');
  vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
  vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
  vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
  coordinator = new LoopCoordinator();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator block sanity gate', () => {
  it('rejects a toolchain-class block when liveness probe is alive and continues looping', async () => {
    const probeSpy = vi
      .spyOn(coordinator as unknown as { runWorkspaceLivenessProbe: (cwd: string, timeoutMs: number) => Promise<{ alive: boolean; detail: string }> }, 'runWorkspaceLivenessProbe')
      .mockResolvedValue({ alive: true, detail: 'exec-ok; fs-ok' });

    const pausedSignals: unknown[] = [];
    coordinator.on('loop:paused-no-progress', (payload) => pausedSignals.push(payload));

    let invokeCount = 0;
    let secondPrompt = '';
    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        prompt: string;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      invokeCount += 1;
      if (invokeCount === 1) {
        const code = await runLoopControlCli(
          [
            'node',
            'aio-loop-control',
            'block',
            '--summary',
            'Toolchain degraded: tools returning empty output and reads look synthetic',
          ],
          p.loopControlEnv,
          silentIo(),
        );
        expect(code).toBe(0);
      } else if (invokeCount === 2) {
        secondPrompt = p.prompt;
      }
      p.callback(iterationResult(`iteration-${invokeCount}`));
    });

    const state = await coordinator.startLoop('chat-block-sanity-alive', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 8000);
      const live = coordinator.getLoop(state.id);
      expect(live?.status).not.toBe('paused');
      expect(live?.terminalIntentHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'block',
            status: 'rejected',
            statusReason: expect.stringContaining('liveness probe passed'),
          }),
        ]),
      );
      expect(secondPrompt).toContain('Your block intent was NOT honored.');
      expect(pausedSignals).toHaveLength(0);
      expect(probeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('honors a toolchain-class block when liveness probe is dead', async () => {
    vi
      .spyOn(coordinator as unknown as { runWorkspaceLivenessProbe: (cwd: string, timeoutMs: number) => Promise<{ alive: boolean; detail: string }> }, 'runWorkspaceLivenessProbe')
      .mockResolvedValue({ alive: false, detail: 'exec-failed; fs-read-failed' });

    const paused = waitForEvent<{ signal: { message: string; detail?: Record<string, unknown> } }>(
      coordinator,
      'loop:paused-no-progress',
      5000,
    );

    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        [
          'node',
          'aio-loop-control',
          'block',
          '--summary',
          'tools are non-responsive and returning empty output',
        ],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('blocked'));
    });

    const state = await coordinator.startLoop('chat-block-sanity-dead', {
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
      const pausedEvent = await paused;
      expect(coordinator.getLoop(state.id)?.status).toBe('paused');
      expect(pausedEvent.signal.message).toContain('liveness probe failed');
      expect(pausedEvent.signal.detail).toMatchObject({
        probeDetail: expect.stringContaining('exec-failed; fs-read-failed'),
      });
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('honors a non-toolchain block with evidence without running the probe', async () => {
    const probeSpy = vi.spyOn(
      coordinator as unknown as { runWorkspaceLivenessProbe: (cwd: string, timeoutMs: number) => Promise<{ alive: boolean; detail: string }> },
      'runWorkspaceLivenessProbe',
    );
    const paused = waitForEvent(coordinator, 'loop:paused-no-progress', 5000);

    coordinator.on('loop:invoke-iteration', async (payload: unknown) => {
      const p = payload as {
        loopControlEnv: NodeJS.ProcessEnv;
        callback: (result: LoopChildResult | { error: string }) => void;
      };
      const code = await runLoopControlCli(
        [
          'node',
          'aio-loop-control',
          'block',
          '--summary',
          'Missing OPENAI_API_KEY, cannot proceed safely',
          '--evidence',
          'command:printenv=OPENAI_API_KEY=<missing>',
        ],
        p.loopControlEnv,
        silentIo(),
      );
      expect(code).toBe(0);
      p.callback(iterationResult('blocked'));
    });

    const state = await coordinator.startLoop('chat-block-sanity-non-toolchain', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
    });

    try {
      await paused;
      expect(coordinator.getLoop(state.id)?.status).toBe('paused');
      expect(probeSpy).not.toHaveBeenCalled();
      expect(coordinator.getLoop(state.id)?.terminalIntentHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'block', status: 'accepted' }),
        ]),
      );
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });

  it('classifier marks toolchain-class and evidence-less blocks, but not API-key-with-evidence', () => {
    const isToolchainClassBlock = (coordinator as unknown as {
      isToolchainClassBlock: (summary: string, evidence: LoopTerminalIntentEvidence[]) => boolean;
    }).isToolchainClassBlock.bind(coordinator);

    expect(isToolchainClassBlock('Bash read/write commands keep returning empty output', [
      { kind: 'note', label: 'n', value: 'looks broken' },
    ])).toBe(true);

    expect(isToolchainClassBlock('Everything is blocked', [])).toBe(true);

    expect(
      isToolchainClassBlock('Missing OPENAI_API_KEY, cannot proceed', [
        { kind: 'command', label: 'printenv', value: 'OPENAI_API_KEY=<missing>' },
      ]),
    ).toBe(false);
  });

  it('does not pause on BLOCKED.md when probe proves liveness and moves file aside', async () => {
    vi
      .spyOn(coordinator as unknown as { runWorkspaceLivenessProbe: (cwd: string, timeoutMs: number) => Promise<{ alive: boolean; detail: string }> }, 'runWorkspaceLivenessProbe')
      .mockResolvedValue({ alive: true, detail: 'exec-ok; fs-ok' });

    let invokeCount = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      invokeCount += 1;
      if (invokeCount === 1) {
        writeFileSync(join(workspace, 'BLOCKED.md'), 'toolchain unresponsive: read returns empty output');
      }
      p.callback(iterationResult(`iteration-${invokeCount}`));
    });

    const state = await coordinator.startLoop('chat-blocked-md-override', {
      initialPrompt: 'keep going',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 3 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'false',
        runVerifyTwice: false,
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
    });

    try {
      await waitForCondition(() => invokeCount >= 2, 8000);
      expect(coordinator.getLoop(state.id)?.status).not.toBe('paused');
      expect(existsSync(join(workspace, 'BLOCKED.md'))).toBe(false);
      const workspaceFiles = readdirSync(workspace);
      const controlDir = coordinator.getLoop(state.id)?.loopControl?.controlDir;
      const controlDirFiles = controlDir ? readdirSync(controlDir) : [];
      expect(
        workspaceFiles.some((name) => name === 'BLOCKED.overridden.md') ||
        controlDirFiles.some((name) => /^blocked-overridden-\d+\.md$/.test(name)),
      ).toBe(true);
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  });
});

function waitForEvent<T = unknown>(
  currentCoordinator: LoopCoordinator,
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
        currentCoordinator.off(eventName, onEvent);
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
    }
    currentCoordinator.once(eventName, onEvent);
  });
}

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
