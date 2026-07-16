/**
 * P3 acceptance (non-success terminal preservation): when an isolated loop ends
 * in a NON-success terminal state (here: cancelled), the orchestrator must
 * preserve the agent's work — harvest it to the session branch and keep that
 * branch — before reaping the worktree directory. No non-success state is
 * allowed to force-remove unharvested work.
 *
 * Real LoopCoordinator + real WorktreeManager + real git against a temp repo;
 * only the agent's work (the invoke-iteration callback) is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { _resetWorktreeManagerForTesting } from '../workspace/git/worktree-manager';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { hermeticGitEnv } from '../workspace/git/git-env';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}
async function branchExists(branch: string, cwd: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}

let repo: string;
let coordinator: LoopCoordinator;

beforeEach(async () => {
  _resetWorktreeManagerForTesting();
  GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'loop-e2e-abandon-'));
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

describe('E2E: non-success terminal preserves the session branch then reaps the worktree (real git)', () => {
  it('cancelled loop harvests work to the session branch, keeps the branch, removes the dir', async () => {
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        workspaceCwd: string;
        executionCwd?: string;
        callback: (r: LoopChildResult) => void;
      };
      if (p.executionCwd) {
        writeFileSync(join(p.executionCwd, 'agent-output.txt'), 'partial work from a cancelled run\n');
      }
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      queueMicrotask(() => p.callback(claimsDone()));
    });

    const base = defaultLoopConfig(repo, 'do partial work');
    const state = await coordinator.startLoop('chat-abandon', {
      initialPrompt: 'do partial work',
      workspaceCwd: repo,
      isolateLoopWorkspaces: true,
      completion: { ...base.completion, verifyCommand: '' }, // manual-review only → pauses
      caps: { ...base.caps, maxCostCents: 100 },
    });

    const worktreePath = state.config.executionCwd!;
    const branch = state.config.worktreeBranch!;
    expect(worktreePath).toContain('.worktrees');
    expect(existsSync(worktreePath)).toBe(true);
    expect(branch).toBeTruthy();

    // Agent did its work, loop paused awaiting review.
    await waitFor(() => liveState(state.id)?.status === 'paused');
    expect(existsSync(join(worktreePath, 'agent-output.txt'))).toBe(true);

    // NON-success terminal: operator cancels instead of accepting.
    await coordinator.cancelLoop(state.id);

    // The fire-and-forget terminate path: harvest → abandon (keep branch) → reap.
    const reaped = await waitFor(
      () => !existsSync(worktreePath) && (liveState(state.id)?.status === undefined || true),
    );
    expect(reaped).toBe(true);

    // The session branch survives (preserved for review) and contains the
    // harvested partial work...
    expect(await branchExists(branch, repo)).toBe(true);
    const branchFiles = await git(['ls-tree', '-r', '--name-only', branch], repo);
    expect(branchFiles).toContain('agent-output.txt');

    // ...but it was NOT integrated into integration/main (non-success never
    // auto-integrates), and the worktree directory is gone.
    expect(existsSync(join(repo, '.git', 'refs', 'heads', 'integration', 'main'))).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });
});
