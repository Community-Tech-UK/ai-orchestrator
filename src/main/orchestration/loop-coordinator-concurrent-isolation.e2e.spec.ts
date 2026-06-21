/**
 * P2 acceptance (concurrent isolation): starting N isolated loops in the same
 * repo yields N distinct worktrees — each session's executionCwd points at its
 * own `.worktrees/<branch>` directory on a distinct branch, while every loop's
 * workspaceCwd stays pinned to the shared repo root.
 *
 * Real LoopCoordinator + real WorktreeManager + real git against a temp repo.
 * Only the agent's work (the invoke-iteration callback) is faked.
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

let repo: string;
let coordinator: LoopCoordinator;

beforeEach(async () => {
  _resetWorktreeManagerForTesting();
  GitWriteQueue._resetForTesting();
  repo = mkdtempSync(join(tmpdir(), 'loop-e2e-concurrent-'));
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
    filesChanged: ['agent-output.txt'],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('E2E: N concurrent isolated loops yield N distinct worktrees (real git)', () => {
  it('two isolated loops each acquire their own worktree on a distinct branch', async () => {
    // One shared handler drives both loops: each "agent" writes into its OWN
    // executionCwd (worktree), then declares done so the manual-review loop
    // pauses (leaving the worktree on disk for assertions).
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        workspaceCwd: string;
        executionCwd?: string;
        callback: (r: LoopChildResult) => void;
      };
      if (p.executionCwd) {
        writeFileSync(join(p.executionCwd, 'agent-output.txt'), `work from ${p.loopRunId}\n`);
      }
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      queueMicrotask(() => p.callback(claimsDone()));
    });

    const startIsolated = (chatId: string, prompt: string) => {
      const base = defaultLoopConfig(repo, prompt);
      return coordinator.startLoop(chatId, {
        initialPrompt: prompt,
        workspaceCwd: repo,
        isolateLoopWorkspaces: true,
        completion: { ...base.completion, verifyCommand: '' }, // manual-review only
        caps: { ...base.caps, maxCostCents: 100 },
      });
    };

    // Distinct prompts → distinct branch slugs (avoids same-ms collisions).
    const [alpha, beta] = await Promise.all([
      startIsolated('chat-alpha', 'alpha objective: build the alpha module'),
      startIsolated('chat-beta', 'beta objective: build the beta module'),
    ]);

    // Each acquired its own worktree under .worktrees/, on its own branch.
    expect(alpha.config.executionCwd).toBeTruthy();
    expect(beta.config.executionCwd).toBeTruthy();
    expect(alpha.config.executionCwd).not.toBe(beta.config.executionCwd);
    expect(alpha.config.executionCwd).toContain('.worktrees');
    expect(beta.config.executionCwd).toContain('.worktrees');
    expect(existsSync(alpha.config.executionCwd!)).toBe(true);
    expect(existsSync(beta.config.executionCwd!)).toBe(true);

    // Distinct branches; both workspaceCwds stay the shared repo root.
    expect(alpha.config.worktreeBranch).toBeTruthy();
    expect(beta.config.worktreeBranch).toBeTruthy();
    expect(alpha.config.worktreeBranch).not.toBe(beta.config.worktreeBranch);
    expect(alpha.config.workspaceCwd).toBe(repo);
    expect(beta.config.workspaceCwd).toBe(repo);

    // git agrees there are two linked worktrees + the root.
    const worktreeList = await git(['worktree', 'list', '--porcelain'], repo);
    expect(worktreeList).toContain(alpha.config.executionCwd!);
    expect(worktreeList).toContain(beta.config.executionCwd!);

    // Both loops reach paused (manual-review) with each agent's file in its own
    // worktree — proving the two sessions did not collide on a shared tree.
    await waitFor(() => liveState(alpha.id)?.status === 'paused' && liveState(beta.id)?.status === 'paused');
    expect(liveState(alpha.id)?.status).toBe('paused');
    expect(liveState(beta.id)?.status).toBe('paused');
    expect(existsSync(join(alpha.config.executionCwd!, 'agent-output.txt'))).toBe(true);
    expect(existsSync(join(beta.config.executionCwd!, 'agent-output.txt'))).toBe(true);
  });
});
