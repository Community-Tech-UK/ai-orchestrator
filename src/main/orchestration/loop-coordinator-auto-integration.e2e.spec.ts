/**
 * END-TO-END: a real isolated loop, driven through the real LoopCoordinator and
 * the real WorktreeManager against a real temp git repo, must:
 *   1. acquire a per-session worktree on start (executionCwd inside .worktrees/),
 *   2. let the "agent" write a file into that worktree,
 *   3. on terminal-success: harvest the file to the session branch,
 *   4. auto-integrate the session branch into integration/main,
 *   5. reap the session worktree dir.
 *
 * Nothing is mocked here except the agent's work (the invoke-iteration callback):
 * the worktree create/harvest/integrate/reap all run real git.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { _resetWorktreeManagerForTesting } from '../workspace/git/worktree-manager';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { hermeticGitEnv } from '../workspace/git/git-env';

// Full real-loop + real-git lifecycle (acquire → harvest → integrate → reap):
// heavy and timing-sensitive, so give it a generous budget for loaded runs.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}

let repo: string;
let coordinator: LoopCoordinator;

beforeEach(async () => {
  _resetWorktreeManagerForTesting();
  GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'loop-e2e-integrate-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(join(repo, 'STAGE.md'), 'IMPLEMENT\n');
  writeFileSync(join(repo, 'README.md'), '# seed\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '--no-gpg-sign', '-m', 'seed'], repo);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  _resetWorktreeManagerForTesting();
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
});

function liveState(id: string): LoopState | undefined {
  return (coordinator as unknown as { active: Map<string, LoopState> }).active.get(id);
}

async function waitFor(predicate: () => boolean, tries = 800): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

function claimsDone(): LoopChildResult {
  return {
    childInstanceId: null,
    output: '<promise>DONE</promise>\nTASK COMPLETE',
    tokens: 1,
    filesChanged: [{ path: 'agent-output.txt', additions: 1, deletions: 0, contentHash: 'agent-output-hash' }],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('E2E: isolated loop acquire → harvest → auto-integrate → reap (real git)', () => {
  it('lands the agent file on integration/main and reaps the worktree', async () => {
    let capturedExecutionCwd = '';

    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        workspaceCwd: string;
        executionCwd?: string;
        callback: (r: LoopChildResult) => void;
      };
      capturedExecutionCwd = p.executionCwd ?? '';
      // The "agent" writes a real file INTO the worktree (executionCwd), not the root.
      if (p.executionCwd) {
        writeFileSync(join(p.executionCwd, 'agent-output.txt'), 'work from the isolated agent\n');
      }
      // Declare done so the manual-review loop pauses for operator sign-off.
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      queueMicrotask(() => p.callback(claimsDone()));
    });

    const base = defaultLoopConfig(repo, 'do the task');
    const state = await coordinator.startLoop('chat-e2e', {
      initialPrompt: 'do the task',
      workspaceCwd: repo,
      isolateLoopWorkspaces: true,
      // autoIntegrateWorktree defaults to true under isolation.
      completion: { ...base.completion, verifyCommand: '' }, // manual-review only
      caps: { ...base.caps, maxCostCents: 100 },
    });

    // 1. Worktree acquired: executionCwd is inside .worktrees/ and on disk.
    expect(state.config.executionCwd).toBeTruthy();
    expect(state.config.executionCwd).toContain('.worktrees');
    expect(existsSync(state.config.executionCwd!)).toBe(true);
    expect(state.config.workspaceCwd).toBe(repo); // root stays pinned

    // 2. Loop runs an iteration (agent writes into the worktree) then pauses.
    await waitFor(() => liveState(state.id)?.status === 'paused');
    expect(liveState(state.id)?.status).toBe('paused');
    expect(capturedExecutionCwd).toBe(state.config.executionCwd);
    expect(existsSync(join(capturedExecutionCwd, 'agent-output.txt'))).toBe(true);

    const worktreePath = state.config.executionCwd!;

    // 3. Operator accepts → terminal-success (completed-needs-review).
    const accepted = await coordinator.acceptCompletion(state.id);
    expect(accepted).toBe(true);

    // 4. The fire-and-forget terminate path harvests → integrates → reaps.
    //    Wait for the integration branch to exist AND the worktree to be reaped.
    const integrated = await waitFor(
      () =>
        !existsSync(worktreePath) &&
        existsSync(join(repo, '.git', 'refs', 'heads', 'integration', 'main')),
    );
    expect(integrated).toBe(true);

    // 5. integration/main contains the agent's harvested file; root is untouched.
    const files = await git(['ls-tree', '-r', '--name-only', 'integration/main'], repo);
    expect(files).toContain('agent-output.txt');
    expect(await git(['branch', '--show-current'], repo)).toBe('main');
    expect(await git(['ls-tree', '-r', '--name-only', 'main'], repo)).not.toContain('agent-output.txt');

    // The worktree directory was reaped.
    expect(existsSync(worktreePath)).toBe(false);
  });
});
