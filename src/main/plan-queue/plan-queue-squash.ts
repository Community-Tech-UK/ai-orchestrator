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
import { createHash } from 'node:crypto';
import { buildCliEnv } from '../cli/cli-environment';
import { gitExec, WORKTREE_CHECKOUT_TIMEOUT_MS } from '../workspace/git/git-exec';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { CONFLICT_CODES } from './plan-queue-git';
import { runInProcessGroup, type GroupRunResult } from './plan-queue-process';
import { LANDING_MARKER_FILE } from './plan-queue-landing-leftover';
import { assertQueueCheckout, assertQueueCheckoutOwnership, InvalidQueueCheckoutError } from './plan-queue-orphan-checkout';
import { PlanQueueCheckoutOwnershipError, readProvisionedPaths, recoverLeftover } from './plan-queue-worktree';

/** Related tests can approach a full suite and exceed 15 minutes on a busy host.
 * Per-test deadlines and cancellation still apply within this aggregate limit. */
const HOOK_TIMEOUT_MS = 60 * 60_000;
const OUTPUT_TAIL = 6_000;

/** The same rule as the global plan-spec guard (~/.config/git/hooks/plan-spec-guard.sh). */
const ACTIVE_DOCUMENT_RE = /(_spec|_spec_planned|_plan|_livetest|_history)\.md$/i;
const STANDING_REGISTER_MARKER = 'Type: standing register';

/** A closed document to add to the landing commit, at its repo-relative path. */
export interface LandingDocument {
  relativePath: string;
  content: string;
  /** Candidate history preserved verbatim here; its active path stays as on base. */
  historySource?: { relativePath: string; sha256: string | null };
}

export type LandingCommitResult =
  | { status: 'committed'; commit: string }
  | { status: 'nothing-to-land' }
  | { status: 'conflict'; conflictFiles: string[] }
  | { status: 'hook-failed'; output: string; timedOut?: boolean }
  | { status: 'active-documents'; paths: string[] };

/**
 * The detach, squash and restore rewrite the whole working tree, which on a
 * large branch takes longer than the ordinary 30-second Git deadline. A
 * killed squash followed by a killed restore leaves the checkout on a detached
 * HEAD (see plan-queue-landing-leftover.ts).
 */
const TREE_REWRITE_TIMEOUT_MS = WORKTREE_CHECKOUT_TIMEOUT_MS;

function run(args: string[], cwd: string, timeoutMs?: number): Promise<boolean> {
  return gitExec(args, cwd, timeoutMs).then(() => true, () => false);
}

/**
 * Start of a landing: make sure the worktree is on the item branch, and remove
 * any closed documents an earlier attempt copied in. What a crashed landing
 * left behind is put back only on the proof in plan-queue-landing-leftover.ts;
 * any other detached state is refused untouched rather than forced, since
 * edits in it would be thrown away. Returns the rescue ref when the recovery
 * set files aside.
 */
export async function returnToItemCheckout(
  worktreePath: string,
  branchName: string,
  itemId: string,
  repoRoot: string,
  documentPaths: readonly string[] = [],
): Promise<string | null> {
  const rescueRef = await recoverLeftover(worktreePath, branchName, itemId, repoRoot);
  try { await assertQueueCheckout(worktreePath, branchName, repoRoot); }
  catch (error) {
    if (error instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: error });
    throw error;
  }
  if (documentPaths.length) {
    await gitExec(['clean', '-f', '-q', '--', ...documentPaths], worktreePath).catch(() => undefined);
  }
  return rescueRef;
}

/**
 * End of a landing attempt: put the worktree back on the item branch exactly.
 * Forced, and every untracked file removed apart from provisioned ones (and
 * ignored ones, which `clean` without -x keeps), because everything else is
 * scratch this attempt made: the squash, the copied closed documents, or base
 * files a detach stopped part-way left behind. The item's own work is all
 * committed on its branch, since the final checkpoint precedes every squash.
 * `read-tree` first, so files the index alone knows about are removed too.
 */
export async function restoreItemCheckout(worktreePath: string, branchName: string, repoRoot: string): Promise<void> {
  try { await assertQueueCheckoutOwnership(worktreePath, repoRoot); }
  catch (error) {
    if (error instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: error });
    throw error;
  }
  await gitExec(['read-tree', 'HEAD'], worktreePath, TREE_REWRITE_TIMEOUT_MS);
  await gitExec(['checkout', '-f', '-q', branchName], worktreePath, TREE_REWRITE_TIMEOUT_MS);
  const provisioned = await readProvisionedPaths(worktreePath);
  await gitExec(['clean', '-f', '-d', '-q', '--', '.', ...provisioned.map((p) => `:(exclude,literal)${p}`)],
    worktreePath, TREE_REWRITE_TIMEOUT_MS);
  await fs.rm(path.join(await gitExec(['rev-parse', '--absolute-git-dir'], worktreePath), LANDING_MARKER_FILE), { force: true });
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

/** Only an owned history with a byte-verified completed snapshot may leave the squash. */
async function preserveActiveHistories(worktreePath: string, baseTip: string, documents: readonly LandingDocument[]): Promise<void> {
  for (const doc of documents) {
    const source = doc.historySource;
    if (!source) continue;
    if (!/_history_[a-f0-9]{64}_completed\.md$/.test(doc.relativePath)
      || !/_history\.md$/i.test(source.relativePath) || path.isAbsolute(source.relativePath)
      || source.relativePath.split(/[\\/]/).includes('..')) throw new Error('Invalid closure history path');
    const file = path.join(worktreePath, source.relativePath);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error('Candidate history must be a regular file');
    const current = stat ? await fs.readFile(file) : null;
    const sha256 = current === null ? null : createHash('sha256').update(current).digest('hex');
    if (sha256 !== source.sha256 || (current !== null && !Buffer.from(doc.content).includes(current))) {
      throw new Error('Candidate history changed or is missing from its completed snapshot');
    }
    const literal = `:(literal)${source.relativePath}`;
    if (await gitExec(['ls-tree', baseTip, '--', literal], worktreePath)) {
      await gitExec(['restore', '--source', baseTip, '--staged', '--worktree', '--', literal], worktreePath);
    } else {
      await gitExec(['rm', '-f', '--ignore-unmatch', '--', literal], worktreePath);
    }
  }
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
  signal?: AbortSignal,
): Promise<GroupRunResult> {
  return runInProcessGroup('git', ['commit', '--no-gpg-sign', '-q', '-m', message], {
    cwd: worktreePath,
    env: hermeticGitEnv(buildCliEnv()),
    timeoutMs,
    outputTail: OUTPUT_TAIL,
    label: 'the pre-commit hook',
    signal,
  });
}

/**
 * Squash the item branch onto `baseTip`, add the closed documents, and commit
 * with hooks. Returns the new commit (whose parent is `baseTip`) or why none
 * was made. The worktree is back on its branch when this returns.
 */
export async function buildLandingCommit(params: {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  itemId: string;
  baseTip: string;
  message: string;
  documents: readonly LandingDocument[];
  signal?: AbortSignal;
}): Promise<LandingCommitResult> {
  const { repoRoot, worktreePath, branchName, itemId, baseTip, message, documents } = params;
  const documentPaths = documents.map((doc) => doc.relativePath);
  await returnToItemCheckout(worktreePath, branchName, itemId, repoRoot, documentPaths);
  const gitDir = await gitExec(['rev-parse', '--absolute-git-dir'], worktreePath);
  await fs.writeFile(path.join(gitDir, LANDING_MARKER_FILE), baseTip, 'utf-8');
  try {
    await gitExec(['checkout', '-q', '--detach', baseTip], worktreePath, TREE_REWRITE_TIMEOUT_MS);
    if (!(await run(['merge', '--squash', '-q', branchName], worktreePath, TREE_REWRITE_TIMEOUT_MS))) {
      const status = await gitExec(['status', '--porcelain'], worktreePath, TREE_REWRITE_TIMEOUT_MS);
      const conflictFiles = status
        .split('\n')
        .filter((line) => CONFLICT_CODES.has(line.slice(0, 2)))
        .map((line) => line.slice(3).trim());
      return { status: 'conflict', conflictFiles };
    }

    await preserveActiveHistories(worktreePath, baseTip, documents);
    const active = await stagedActiveDocuments(worktreePath);
    if (active.length) return { status: 'active-documents', paths: active };

    for (const doc of documents) {
      const target = path.join(worktreePath, doc.relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, doc.content, 'utf-8');
    }
    if (documentPaths.length) await gitExec(['add', '--', ...documentPaths], worktreePath);

    if (await run(['diff', '--cached', '--quiet'], worktreePath, TREE_REWRITE_TIMEOUT_MS)) return { status: 'nothing-to-land' };

    params.signal?.throwIfAborted();
    const { exitCode, output, timedOut } = await commitWithHooks(worktreePath, message, HOOK_TIMEOUT_MS, params.signal);
    if (exitCode !== 0) return { status: 'hook-failed', output, ...(timedOut ? { timedOut } : {}) };
    return { status: 'committed', commit: await gitExec(['rev-parse', 'HEAD'], worktreePath) };
  } finally {
    await restoreAfterLanding(worktreePath, branchName, documentPaths, repoRoot);
  }
}

/**
 * The restore that ends every landing attempt. A failure replaces whatever the
 * squash returned, so the landing fails and parks; parking's checkpoint puts
 * the folder back (plan-queue-landing-leftover.ts).
 */
async function restoreAfterLanding(worktreePath: string, branchName: string, documentPaths: readonly string[], repoRoot: string): Promise<void> {
  try {
    await restoreItemCheckout(worktreePath, branchName, repoRoot);
  } catch (error) {
    if (error instanceof PlanQueueCheckoutOwnershipError) throw error;
    // An operational proof failure is not an ownership refusal. Prove ownership
    // before even the fallback removes copied evidence from this folder.
    try { await assertQueueCheckoutOwnership(worktreePath, repoRoot); }
    catch (ownershipError) {
      if (ownershipError instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: ownershipError });
      throw ownershipError;
    }
    // The copied documents are landing scratch, not edits: remove them so the
    // recovery cannot carry them onto the branch. Landing copies them in again.
    await Promise.all(documentPaths.map((file) => fs.rm(path.join(worktreePath, file), { force: true })));
    throw new Error(`Landing stopped part-way: this item's folder could not be put back on ${branchName} `
      + `(${error instanceof Error ? error.message : String(error)}). Its work is safe on the branch, and the queue puts the folder back before it next saves it.`, { cause: error });
  }
}
