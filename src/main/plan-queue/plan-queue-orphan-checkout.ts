/** Lifecycle-owned recovery for an explicitly discarded, unregistered checkout. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitExec } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { pathCompareKey } from '../workspace/git/worktree-cleanup';
import type { PlanQueueItem } from './plan-queue.types';

export async function retainedQueuePathExists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Whether the item's folder holds a checkout. A folder with no `.git` entry is
 * what a removal that stopped part-way leaves: Git run there resolves the
 * enclosing repository, so nothing may be committed or reverted in it, and its
 * work is on the branch.
 */
export async function hasCheckout(worktreePath: string): Promise<boolean> {
  try { await fs.lstat(path.join(worktreePath, '.git')); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Resume's repair for a queue folder whose removal stopped part-way (26 Oct: an
 * `.asar` inside an agent's `_scratch` copy). With no `.git`, no Git
 * registration and nothing but what Git ignores, it holds no work a checkpoint
 * would have kept, so it is moved into the quarantine folder (never deleted)
 * and the branch can be checked out there again. Any other folder stays where
 * it is and reattaching refuses it. Returns where it went, or null when the
 * folder is not such a leftover.
 */
export async function setAsideHalfRemovedCheckout(worktreePath: string, branchName: string, repoRoot: string): Promise<string | null> {
  return getGitWriteQueue().enqueue('plan-queue-set-aside-leftover', async () => {
    const folder = await fs.lstat(worktreePath).catch(() => null);
    if (!folder?.isDirectory() || !branchName.startsWith('queue/') || await hasCheckout(worktreePath)) return null;
    const root = await fs.realpath(await gitExec(['rev-parse', '--show-toplevel'], repoRoot));
    const expectedPath = path.join(root, '.worktrees', branchName);
    if (pathCompareKey(await fs.realpath(worktreePath)) !== pathCompareKey(expectedPath)) return null;
    const commonDir = await fs.realpath(await gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], root));
    await requireUnregistered(root, expectedPath, branchName, path.join(commonDir, 'worktrees', path.basename(expectedPath)));
    const entries = await fs.readdir(expectedPath, { withFileTypes: true });
    if (!(await allIgnored(root, entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))))) return null;
    const destination = path.join(await quarantineContainer(root, expectedPath), 'leftover');
    await fs.rename(expectedPath, destination);
    return destination;
  });
}

/**
 * True when the repository's ignore rules cover every path; a directory is passed
 * with a trailing `/`. The names are checked as if at the repository root, where
 * they sit in a checkout: prefixed with the queue folder they would always match
 * the root's `.worktrees/` rule.
 */
async function allIgnored(root: string, paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  try {
    // A name Git has to quote does not match, so its folder is left alone.
    const matched = new Set((await gitExec(['-c', 'core.quotePath=false', 'check-ignore', '--', ...paths], root)).split('\n'));
    return paths.every((entry) => matched.has(entry));
  } catch (error) {
    // check-ignore exits 1 when no path is ignored.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

async function quarantineContainer(root: string, checkout: string): Promise<string> {
  const quarantineRoot = path.join(root, '.worktrees', 'queue-quarantine');
  await fs.mkdir(quarantineRoot, { recursive: true });
  await requireDirectory(quarantineRoot);
  return fs.mkdtemp(path.join(quarantineRoot, `${path.basename(checkout)}-`));
}

export async function assertQueueCheckout(worktreePath: string, branchName: string, repoRoot: string): Promise<void> {
  try {
    const gitfile = await fs.lstat(path.join(worktreePath, '.git'));
    if (!gitfile.isFile() || gitfile.isSymbolicLink()) throw new Error('Invalid gitfile');
    const root = await gitExec(['rev-parse', '--show-toplevel'], worktreePath);
    const branch = await gitExec(['symbolic-ref', '--short', 'HEAD'], worktreePath);
    const actualCommon = await gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreePath);
    const expectedCommon = await gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoRoot);
    if (pathCompareKey(await fs.realpath(root)) !== pathCompareKey(await fs.realpath(worktreePath)) || branch !== branchName
      || pathCompareKey(await fs.realpath(actualCommon)) !== pathCompareKey(await fs.realpath(expectedCommon))) {
      throw new Error('Checkout identity differs from its owning item');
    }
  } catch {
    throw new Error('The saved queue checkout is invalid or belongs to another branch. Its files are unchanged. An explicitly approved Discard can preserve an item-owned orphan checkout before retrying; foreign or registered checkouts are refused.');
  }
}

async function requireDirectory(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing a symlink or non-directory queue path');
}

async function requireUnregistered(root: string, target: string, branch: string, metadata: string): Promise<void> {
  if (await retainedQueuePathExists(metadata)) throw new Error('Checkout metadata still exists; refusing to treat it as an orphan');
  const listed = await gitExec(['worktree', 'list', '--porcelain'], root);
  if (listed.split('\n').some((line) => line === `branch refs/heads/${branch}`
    || (line.startsWith('worktree ') && pathCompareKey(line.slice(9)) === pathCompareKey(target)))) {
    throw new Error('Git still registers this checkout or branch; refusing orphan recovery');
  }
}

/**
 * Does not remove content or manufacture Git metadata. The caller already holds
 * the item lock and has explicit Discard authority; the Git queue serialises
 * this proof and move against other coordinator Git operations.
 */
export async function quarantineOrphanCheckout(
  item: PlanQueueItem,
  repoRoot: string,
  expectedBranch: string,
  save: (item: PlanQueueItem) => void,
): Promise<PlanQueueItem> {
  return getGitWriteQueue().enqueue('plan-queue-quarantine-orphan', async () => {
    if (item.state !== 'parked' || item.branchName !== expectedBranch || !expectedBranch.startsWith('queue/')) {
      throw new Error('Only the owning parked queue item can discard an orphan checkout');
    }
    const root = await fs.realpath(await gitExec(['rev-parse', '--show-toplevel'], repoRoot));
    const expectedPath = path.join(root, '.worktrees', expectedBranch);
    if (!item.worktreePath || pathCompareKey(path.resolve(item.worktreePath)) !== pathCompareKey(expectedPath)) {
      throw new Error('The retained checkout path does not match its queue item');
    }
    const ownedParents = [path.join(root, '.worktrees'), path.join(root, '.worktrees', 'queue')];
    for (const target of [...ownedParents, expectedPath]) {
      await requireDirectory(target);
    }
    const sourceIdentity = await fs.lstat(expectedPath);
    const gitfilePath = path.join(expectedPath, '.git');
    const gitfile = await fs.lstat(gitfilePath);
    if (!gitfile.isFile() || gitfile.isSymbolicLink()) throw new Error('Refusing an unrecognised checkout gitfile');
    const pointerText = await fs.readFile(gitfilePath, 'utf8');
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointerText)?.[1];
    const commonDir = await fs.realpath(await gitExec(['rev-parse', '--path-format=absolute', '--git-common-dir'], root));
    const expectedMetadata = path.join(commonDir, 'worktrees', path.basename(expectedPath));
    if (!pointer || !path.isAbsolute(pointer) || pathCompareKey(path.resolve(pointer)) !== pathCompareKey(expectedMetadata)) {
      throw new Error('The orphan gitfile does not point to this repository and item');
    }
    await requireUnregistered(root, expectedPath, expectedBranch, expectedMetadata);
    const container = await quarantineContainer(root, expectedPath);
    const quarantineRoot = path.dirname(container);
    const destination = path.join(container, 'checkout');
    const receipt = `Orphan checkout recovery location: ${destination}\n`;
    const recorded = { ...item, detail: receipt + (item.detail ?? '').slice(0, 8000 - receipt.length) };
    // Persist the destination BEFORE moving; a restart or failed subsequent save
    // still has the receipt, and retry can observe that the old path is absent.
    save(recorded);
    // A save may yield control to another writer. Recheck path identity at the
    // mutation boundary; never follow a replaced parent or move another copy.
    for (const target of [...ownedParents, quarantineRoot, container, expectedPath]) await requireDirectory(target);
    const freshIdentity = await fs.lstat(expectedPath);
    const freshGitfile = await fs.lstat(gitfilePath);
    if (freshIdentity.dev !== sourceIdentity.dev || freshIdentity.ino !== sourceIdentity.ino
      || !freshGitfile.isFile() || freshGitfile.isSymbolicLink()
      || await fs.readFile(gitfilePath, 'utf8') !== pointerText) {
      throw new Error('The orphan checkout changed during recovery; its files are unchanged');
    }
    await requireUnregistered(root, expectedPath, expectedBranch, expectedMetadata);
    await fs.rename(expectedPath, destination);
    const retainedReceipt = `Orphan checkout retained at ${destination}\n`;
    const cleared = { ...recorded, worktreePath: null, detail: retainedReceipt + (item.detail ?? '').slice(0, 8000 - retainedReceipt.length) };
    save(cleared);
    return cleared;
  });
}
