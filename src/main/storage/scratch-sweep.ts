import { promises as fs } from 'fs';
import type { Dirent, Stats } from 'fs';
import * as path from 'path';
import { isBroadWorkspaceRoot } from '../codemem/broad-workspace-roots';
import { removeTree } from '../util/remove-tree';
import { gitExec } from '../workspace/git/git-exec';

/**
 * Daily sweep of agent throwaway folders. Agents put isolated checkouts, test
 * copies and evidence under a project's `_scratch/` (the documented disposable
 * location) and often never delete them: one project's `apps/desk/_scratch`
 * reached ~520 GB across ~2,500 gate runs in October 2026.
 *
 * Only top-level `_scratch/` entries are removed, only once nothing inside them
 * has changed for the retention period, and never when they hold a git
 * checkout with uncommitted changes or commits missing from the owning repo.
 */

/** How deep below a project root to look for `_scratch/` folders. */
const SCRATCH_SEARCH_DEPTH = 3;
/**
 * Most folders walked inside one entry while looking for git repositories. An
 * entry too large to inspect fully is kept rather than deleted unchecked.
 */
const MAX_FOLDERS_INSPECTED = 200_000;
/** Folders never searched for `_scratch/`. */
const SCRATCH_SEARCH_SKIP = new Set(['node_modules', '.git', '.worktrees', '_archive', '.venv', 'venv', '__pycache__']);
/**
 * Folders whose timestamps say nothing about recent use: they reflect install
 * or clone time, and walking them is most of the cost on a full repo copy.
 */
const ACTIVITY_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);
/** Checkouts with more unpushed commits than this are kept rather than checked one by one. */
const MAX_COMMITS_TO_CHECK = 5_000;

export type ScratchEntryDecision =
  | { kind: 'removed'; path: string }
  | { kind: 'kept-recent'; path: string }
  | { kind: 'kept-unsaved-work'; path: string; reason: string }
  | { kind: 'failed'; path: string; error: string };

export interface ScratchSweepOptions {
  projectRoots: readonly string[];
  retentionDays: number;
  now?: number;
  /** Decide without deleting; `removed` then means "would be removed". */
  dryRun?: boolean;
  /** When a file or folder last changed; injectable because tests cannot set ctime. */
  activityTimeMs?: (stat: ActivityStat) => number;
}

export type ActivityStat = Pick<Stats, 'mtimeMs' | 'ctimeMs'>;

/**
 * The later of the content and status change times. `cp -a` and `rsync -a`
 * keep a copy's old modification time, but its status-change time is when it
 * was copied, so a fresh copy of an old tree still counts as recent.
 */
export function defaultActivityTimeMs(stat: ActivityStat): number {
  return Math.max(stat.mtimeMs, stat.ctimeMs);
}

export async function sweepScratchFolders(options: ScratchSweepOptions): Promise<ScratchEntryDecision[]> {
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) return [];
  const cutoffMs = (options.now ?? Date.now()) - options.retentionDays * 24 * 60 * 60 * 1000;
  const scratchDirs = new Set<string>();
  for (const root of options.projectRoots) {
    const resolved = path.resolve(root);
    if (isBroadWorkspaceRoot(resolved) || isInsideDisposableFolder(resolved)) continue;
    for (const dir of await findScratchDirs(resolved, SCRATCH_SEARCH_DEPTH)) scratchDirs.add(dir);
  }

  const decisions: ScratchEntryDecision[] = [];
  for (const scratchDir of scratchDirs) {
    const ownerRepo = await gitToplevel(path.dirname(scratchDir));
    for (const entry of await readDirSafe(scratchDir)) {
      const entryPath = path.join(scratchDir, entry.name);
      decisions.push(await decideAndSweep(entryPath, ownerRepo, {
        cutoffMs,
        dryRun: options.dryRun === true,
        activityTimeMs: options.activityTimeMs ?? defaultActivityTimeMs,
      }));
    }
  }
  return decisions;
}

async function decideAndSweep(
  entryPath: string,
  ownerRepo: string | null,
  options: { cutoffMs: number; dryRun: boolean; activityTimeMs: (stat: ActivityStat) => number },
): Promise<ScratchEntryDecision> {
  try {
    if (await hasActivitySince(entryPath, options.cutoffMs, options.activityTimeMs)) {
      return { kind: 'kept-recent', path: entryPath };
    }
    if ((await fs.lstat(entryPath)).isSymbolicLink()) {
      // Remove only the link. Its target may be a real checkout elsewhere;
      // following it into git (or `git worktree remove`) would delete that.
      if (!options.dryRun) await fs.unlink(entryPath);
      return { kind: 'removed', path: entryPath };
    }
    const inspection = await inspectEntry(entryPath, ownerRepo);
    if (inspection.unsaved) return { kind: 'kept-unsaved-work', path: entryPath, reason: inspection.unsaved };
    if (!options.dryRun) {
      for (const worktree of inspection.linkedWorktrees) {
        // Unregister just this worktree. A repo-wide `git worktree prune` would
        // also drop worktrees that are only temporarily missing (an unplugged
        // drive), orphaning their commits.
        await gitExec(['worktree', 'remove', '--force', '--force', worktree.checkout], worktree.commonDir)
          .catch(() => undefined);
      }
      await removeSealedTree(entryPath);
    }
    return { kind: 'removed', path: entryPath };
  } catch (error) {
    return { kind: 'failed', path: entryPath, error: error instanceof Error ? error.message : String(error) };
  }
}

function isInsideDisposableFolder(dir: string): boolean {
  return dir.split(path.sep).some((part) => part === '_scratch' || part === '.worktrees');
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findScratchDirs(root: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readDirSafe(root)) {
    if (!entry.isDirectory()) continue;
    const child = path.join(root, entry.name);
    if (entry.name === '_scratch') {
      found.push(child);
    } else if (depth > 1 && !SCRATCH_SEARCH_SKIP.has(entry.name) && !entry.name.startsWith('.')) {
      found.push(...await findScratchDirs(child, depth - 1));
    }
  }
  return found;
}

/** True when anything in the entry, outside dependency and git internals, changed after the cutoff. */
export async function hasActivitySince(
  entryPath: string,
  cutoffMs: number,
  activityTimeMs: (stat: ActivityStat) => number = defaultActivityTimeMs,
): Promise<boolean> {
  const stat = await fs.lstat(entryPath);
  if (activityTimeMs(stat) > cutoffMs) return true;
  if (!stat.isDirectory()) return false;
  for (const entry of await readDirSafe(entryPath)) {
    if (ACTIVITY_SKIP.has(entry.name) && entry.isDirectory()) continue;
    if (await hasActivitySince(path.join(entryPath, entry.name), cutoffMs, activityTimeMs)) return true;
  }
  return false;
}

interface EntryInspection {
  /** Why the entry must be kept, or null when nothing in it is unsaved. */
  unsaved: string | null;
  /** Linked worktrees of repositories outside the entry, to unregister before deleting. */
  linkedWorktrees: { checkout: string; commonDir: string }[];
}

/** A working tree (has `.git`) or a bare repository found inside a scratch entry. */
interface RepoInEntry {
  path: string;
  bare: boolean;
}

/**
 * Check every git repository inside the entry. A repository whose history is
 * stored inside the entry (a clone, a bare repo, a separate-git-dir clone)
 * loses that history when the entry goes, so all of its commits must be
 * reachable from the owning project's refs. A linked worktree of a repository
 * outside the entry keeps its history, but a detached HEAD there is on no
 * branch and would be orphaned.
 */
async function inspectEntry(entryPath: string, ownerRepo: string | null): Promise<EntryInspection> {
  const linkedWorktrees: EntryInspection['linkedWorktrees'] = [];
  const entryRealPath = await fs.realpath(entryPath);
  const search = { repos: [] as RepoInEntry[], foldersLeft: MAX_FOLDERS_INSPECTED };
  await findRepos(entryPath, search);
  if (search.foldersLeft < 0) return unsaved(`${entryPath} is too large to check for unsaved git work`);
  for (const repo of search.repos) {
    if (!repo.bare) {
      // --untracked-files=all overrides a status.showUntrackedFiles=no config,
      // and --ignore-submodules=none a diff.ignoreSubmodules one. Gitignored
      // files (node_modules, build output) still do not show; repositories
      // nested inside ignored folders are found and checked on their own.
      const status = await gitExec(
        ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'],
        repo.path,
      ).catch(() => null);
      if (status === null) return unsaved(`could not read git status in ${repo.path}`);
      if (status.length > 0) return unsaved(`uncommitted changes in ${repo.path}`);
    }

    const commonDirOutput = await gitExec(['rev-parse', '--git-common-dir'], repo.path).catch(() => null);
    if (!commonDirOutput) return unsaved(`could not find the git folder for ${repo.path}`);
    const commonDir = await fs.realpath(path.resolve(repo.path, commonDirOutput)).catch(() => null);
    if (!commonDir) return unsaved(`could not find the git folder for ${repo.path}`);

    if (!isInside(commonDir, entryRealPath)) {
      const orphaned = await gitExec(['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes'], repo.path)
        .catch(() => null);
      if (orphaned === null) return unsaved(`could not list commits in ${repo.path}`);
      const count = countLines(orphaned);
      if (count > 0) return unsaved(`${count} commit(s) in ${repo.path} are on no branch`);
      linkedWorktrees.push({ checkout: repo.path, commonDir });
      continue;
    }

    const outsideWorktree = await findWorktreeOutside(commonDir, entryRealPath);
    if (outsideWorktree) return unsaved(`${repo.path} has a linked worktree outside this folder at ${outsideWorktree}`);

    const local = await gitExec(['rev-list', '--all', '--not', '--remotes'], repo.path).catch(() => null);
    if (local === null) return unsaved(`could not list commits in ${repo.path}`);
    const commits = local.split('\n').filter(Boolean);
    if (commits.length === 0) continue;
    if (!ownerRepo || commits.length > MAX_COMMITS_TO_CHECK) return unsaved(`commits not pushed anywhere in ${repo.path}`);
    const notSaved = await countCommitsNotReachable(ownerRepo, commits);
    if (notSaved === null) return unsaved(`could not compare commits in ${repo.path} with ${ownerRepo}`);
    if (notSaved > 0) return unsaved(`${notSaved} commit(s) in ${repo.path} are not on any branch of ${ownerRepo}`);
  }
  return { unsaved: null, linkedWorktrees };
}

function unsaved(reason: string): EntryInspection {
  return { unsaved: reason, linkedWorktrees: [] };
}

/**
 * Commits that are missing from the owner, or present only as loose objects
 * no ref reaches (which `git gc` will eventually delete).
 */
async function countCommitsNotReachable(ownerRepo: string, commits: readonly string[]): Promise<number | null> {
  try {
    const present = (await gitExec(['rev-list', '--no-walk', '--ignore-missing', ...commits], ownerRepo))
      .split('\n').filter(Boolean);
    const missing = commits.length - new Set(present).size;
    if (present.length === 0) return missing;
    const unreachable = await gitExec(['rev-list', ...present, '--not', '--all'], ownerRepo);
    return missing + countLines(unreachable);
  } catch {
    return null;
  }
}

function countLines(output: string): number {
  return output.split('\n').filter(Boolean).length;
}

function isInside(target: string, dir: string): boolean {
  const relative = path.relative(dir, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Collect every git repository under `dir`, including ones nested inside
 * another checkout (an ignored `vendor/` clone, a `.worktrees/` worktree, a
 * submodule). Symlinks are not followed. `foldersLeft` going negative means
 * the walk stopped early.
 */
async function findRepos(dir: string, search: { repos: RepoInEntry[]; foldersLeft: number }): Promise<void> {
  if (--search.foldersLeft < 0) return;
  const entries = await readDirSafe(dir);
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('.git')) {
    search.repos.push({ path: dir, bare: false });
  } else if (names.has('HEAD') && names.has('objects') && names.has('refs')) {
    search.repos.push({ path: dir, bare: true });
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
    await findRepos(path.join(dir, entry.name), search);
    if (search.foldersLeft < 0) return;
  }
}

/** A worktree registered in `commonDir` whose checkout still exists outside the entry. */
async function findWorktreeOutside(commonDir: string, entryRealPath: string): Promise<string | null> {
  for (const worktree of await readDirSafe(path.join(commonDir, 'worktrees'))) {
    const gitdirFile = path.join(commonDir, 'worktrees', worktree.name, 'gitdir');
    const pointer = (await fs.readFile(gitdirFile, 'utf-8').catch(() => '')).trim();
    if (!pointer) continue;
    const checkout = await fs.realpath(path.dirname(path.resolve(commonDir, pointer))).catch(() => null);
    if (checkout && !isInside(checkout, entryRealPath)) return checkout;
  }
  return null;
}

async function gitToplevel(dir: string): Promise<string | null> {
  const top = await gitExec(['rev-parse', '--show-toplevel'], dir).catch(() => '');
  return top ? path.resolve(top) : null;
}

/** Remove a tree, restoring owner write permission on folders agents sealed read-only. */
async function removeSealedTree(target: string): Promise<void> {
  try {
    await removeTree(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    await makeWritable(target);
    await removeTree(target);
  }
}

async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return;
  await fs.chmod(target, stat.mode | 0o700);
  for (const entry of await readDirSafe(target)) {
    if (entry.isDirectory()) await makeWritable(path.join(target, entry.name));
  }
}
