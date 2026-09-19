/**
 * Plan Queue landing commit — built in the item's own worktree so the
 * repository's pre-commit hook runs for real.
 *
 * The item worktree is provisioned with dependencies when it is created, so
 * the hook (the plan-spec guard, the committed-artifact generators and
 * related tests) can run there, where a throwaway integration checkout could
 * not. The worktree holds only this item's work, so the generators' `git add`
 * cannot sweep anyone else's state into the commit.
 *
 * The squash is made on a detached HEAD at the base tip and the worktree is
 * always put back on the item branch afterwards, so the item's checkpointed
 * work and the removal proof are never disturbed. Nothing here moves the base
 * branch; promotion is the caller's job.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { buildCliEnv } from '../cli/cli-environment';
import { gitExec } from '../workspace/git/git-exec';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { CONFLICT_CODES } from './plan-queue-git';
import { runInProcessGroup } from './plan-queue-process';

/** Hooks run generators and related tests; give them the same budget as a gate command. */
const HOOK_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_TAIL = 6_000;

/** The same rule as the global plan-spec guard (~/.config/git/hooks/plan-spec-guard.sh). */
const ACTIVE_DOCUMENT_RE = /(_spec|_spec_planned|_plan|_livetest)\.md$/i;
const STANDING_REGISTER_MARKER = 'Type: standing register';

/** A closed document to add to the landing commit, at its repo-relative path. */
export interface LandingDocument {
  relativePath: string;
  content: string;
}

export type LandingCommitResult =
  | { status: 'committed'; commit: string }
  | { status: 'nothing-to-land' }
  | { status: 'conflict'; conflictFiles: string[] }
  | { status: 'hook-failed'; output: string }
  | { status: 'active-documents'; paths: string[] };

function run(args: string[], cwd: string): Promise<boolean> {
  return gitExec(args, cwd).then(() => true, () => false);
}

/**
 * Put the worktree back on the item branch and remove any closed documents a
 * landing attempt copied in. A no-op for a worktree already on its branch, so
 * it is safe to call at the start of every landing, including after a crash
 * that left the detached squash state behind.
 */
export async function restoreItemCheckout(
  worktreePath: string,
  branchName: string,
  documentPaths: readonly string[] = [],
): Promise<void> {
  const head = await gitExec(['symbolic-ref', '-q', 'HEAD'], worktreePath).catch(() => '');
  if (head !== `refs/heads/${branchName}`) {
    // Only ever a squash scratch state: the item's work is committed on its
    // branch (the final checkpoint precedes every squash), so nothing is lost.
    await gitExec(['checkout', '-f', '-q', branchName], worktreePath);
  }
  if (documentPaths.length) {
    await gitExec(['clean', '-f', '-q', '--', ...documentPaths], worktreePath).catch(() => undefined);
  }
}

async function stagedActiveDocuments(worktreePath: string): Promise<string[]> {
  const staged = (await gitExec(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], worktreePath))
    .split('\n')
    .filter((file) => ACTIVE_DOCUMENT_RE.test(file));
  const blocked: string[] = [];
  for (const file of staged) {
    const head = await gitExec(['show', `:${file}`], worktreePath).catch(() => '');
    if (!head.split('\n').slice(0, 8).some((line) => line.includes(STANDING_REGISTER_MARKER))) {
      blocked.push(file);
    }
  }
  return blocked;
}

/**
 * `git commit` with the repository's hooks, a PATH that can find node/npm, and
 * the output kept. Run in its own process group (see plan-queue-process.ts) so
 * no generator or test the hook started outlives it in the worktree the next
 * worker is handed.
 */
export function commitWithHooks(
  worktreePath: string,
  message: string,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<{ exitCode: number; output: string }> {
  return runInProcessGroup('git', ['commit', '--no-gpg-sign', '-q', '-m', message], {
    cwd: worktreePath,
    env: hermeticGitEnv(buildCliEnv()),
    timeoutMs,
    outputTail: OUTPUT_TAIL,
    label: 'the pre-commit hook',
  });
}

/**
 * Squash the item branch onto `baseTip`, add the closed documents, and commit
 * with hooks. Returns the new commit (whose parent is `baseTip`) or why none
 * was made. The worktree is back on its branch when this returns.
 */
export async function buildLandingCommit(params: {
  worktreePath: string;
  branchName: string;
  baseTip: string;
  message: string;
  documents: readonly LandingDocument[];
}): Promise<LandingCommitResult> {
  const { worktreePath, branchName, baseTip, message, documents } = params;
  const documentPaths = documents.map((doc) => doc.relativePath);
  await restoreItemCheckout(worktreePath, branchName, documentPaths);
  try {
    await gitExec(['checkout', '-q', '--detach', baseTip], worktreePath);
    if (!(await run(['merge', '--squash', '-q', branchName], worktreePath))) {
      const status = await gitExec(['status', '--porcelain'], worktreePath);
      const conflictFiles = status
        .split('\n')
        .filter((line) => CONFLICT_CODES.has(line.slice(0, 2)))
        .map((line) => line.slice(3).trim());
      return { status: 'conflict', conflictFiles };
    }

    const active = await stagedActiveDocuments(worktreePath);
    if (active.length) return { status: 'active-documents', paths: active };

    for (const doc of documents) {
      const target = path.join(worktreePath, doc.relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, doc.content, 'utf-8');
    }
    if (documentPaths.length) await gitExec(['add', '--', ...documentPaths], worktreePath);

    if (await run(['diff', '--cached', '--quiet'], worktreePath)) return { status: 'nothing-to-land' };

    const { exitCode, output } = await commitWithHooks(worktreePath, message);
    if (exitCode !== 0) return { status: 'hook-failed', output };
    return { status: 'committed', commit: await gitExec(['rev-parse', 'HEAD'], worktreePath) };
  } finally {
    await restoreItemCheckout(worktreePath, branchName, documentPaths);
  }
}
