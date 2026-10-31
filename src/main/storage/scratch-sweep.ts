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
 * checkout with uncommitted changes or commits missing from the owning repo —
 * including commits kept only in a submodule store after its checkout was
 * deinitialized, git folders that an outside checkout still runs on, and edits
 * hidden from `git status` behind skip-worktree or assume-unchanged. A
 * matching commit ID is not enough either: the owning project must actually
 * keep the objects behind those commits (a `--filter=blob:none` clone lists
 * every commit while its historical blobs live elsewhere) and must not read
 * its own objects from inside the entry or through a name the entry holds (an
 * `objects/info/alternates` chain — the owner re-resolves every name in it on
 * each command, so every spelling that resolution runs through, symlink hops
 * included, is required just like the store it reaches, the alternates
 * lists the chain is read out of — plain files and symlink targets alike —
 * are required metadata in their own right, and so is every link below a
 * store root: the packed and loose objects are read through the paths sitting
 * there — a `pack` folder, one `.pack`, a loose-object fanout, one loose
 * object — so a link the entry holds or leads to dies with the entry).
 * Every repository's
 * configured checkout (`core.worktree`) is resolved and validated instead of
 * inferring containment from where its git folder sits.
 * Inspection fails closed: a folder that cannot be read, or a tree too large to
 * walk, keeps the entry instead of being treated as empty.
 */

/** How deep below a project root to look for `_scratch/` folders. */
const SCRATCH_SEARCH_DEPTH = 3;
/**
 * Most folders walked inside one entry while inspecting it (for recent
 * activity and for git repositories). An entry too large to inspect fully is
 * kept rather than deleted unchecked.
 */
const MAX_FOLDERS_INSPECTED = 200_000;
/**
 * How many `objects/info/alternates` links are followed from one store. Git
 * itself stops nesting far below this (it ignores alternates past about five
 * links, so any reachable store is followed here); a chain deeper than this —
 * or one cycling through symlinks into endless spellings of the same stores —
 * cannot be proven independent of the entries and fails closed.
 */
const MAX_ALTERNATE_CHAIN_DEPTH = 32;
/**
 * Most symlink hops followed while resolving one object store name (the
 * kernel's own ELOOP bound). A name cycling through links into endless
 * spellings of the same path cannot be proven independent of the entries and
 * fails closed.
 */
const MAX_SYMLINK_HOPS = 32;
/**
 * Most symlinks tracked below the object store roots of one owner. Each one
 * can be the only path to the packed or loose objects behind it (a `pack`
 * folder moved aside and linked back, one `.pack`, a loose-object fanout, one
 * loose object), so each one is recorded; a store linked through more paths
 * than this cannot be tracked entry by entry and fails closed.
 */
const MAX_OBJECT_STORE_LINKS = 1_000;
/** Folders never searched for `_scratch/`. */
const SCRATCH_SEARCH_SKIP = new Set(['node_modules', '.git', '.worktrees', '_archive', '.venv', 'venv', '__pycache__']);
/**
 * Folders whose contents are not judged for activity: git's own store churns on
 * every fetch, gc and commit — and even on the sweeper's own `git status` runs,
 * which can refresh `.git/index` — so its timestamps cannot show whether anyone
 * is using the entry. Unsaved work in a repository is fully decided by the
 * repository checks instead. Dependency and cache folders count as activity
 * like everything else: a recent install or patch is a real touch, and they can
 * hide nested checkouts.
 */
const ACTIVITY_SKIP = new Set(['.git']);

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
    // One read of the owning project's surviving history per scratch folder:
    // every entry under it is compared against the same set of surviving
    // commits, object stores and object completeness.
    const saved = ownerRepo === null ? null : await loadOwnerSurvival(ownerRepo);
    const entries = await readDir(scratchDir);
    if (entries === null) {
      // Nothing can be enumerated here, so nothing is approved for deletion.
      decisions.push({ kind: 'failed', path: scratchDir, error: `could not read ${scratchDir}` });
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(scratchDir, entry.name);
      decisions.push(await decideAndSweep(entryPath, ownerRepo, saved, {
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
  saved: OwnerSurvival | null,
  options: { cutoffMs: number; dryRun: boolean; activityTimeMs: (stat: ActivityStat) => number },
): Promise<ScratchEntryDecision> {
  try {
    const activity = await scanActivitySince(entryPath, options.cutoffMs, options.activityTimeMs);
    if (activity.kind === 'recent') return { kind: 'kept-recent', path: entryPath };
    if (activity.kind === 'blocked') return { kind: 'kept-unsaved-work', path: entryPath, reason: activity.reason };
    const entryStat = await fs.lstat(entryPath);
    // Every entry kind is checked before anything is removed: a folder can
    // hold an object store, and a plain file or symlink can be — or lead to —
    // the `objects/info/alternates` metadata the owner reads its chain out of.
    const blocked = await ownerObjectStoreDependency(entryPath, ownerRepo, saved);
    if (blocked !== null) return { kind: 'kept-unsaved-work', path: entryPath, reason: blocked };
    if (entryStat.isSymbolicLink()) {
      // Remove only the link. Its target may be a real checkout elsewhere;
      // following it into git (or `git worktree remove`) would delete that.
      if (!options.dryRun) await fs.unlink(entryPath);
      return { kind: 'removed', path: entryPath };
    }
    const inspection = await inspectEntry(entryPath, entryStat, ownerRepo, saved);
    if (inspection.unsaved) return { kind: 'kept-unsaved-work', path: entryPath, reason: inspection.unsaved };
    if (!options.dryRun) {
      for (const worktree of inspection.linkedWorktrees) {
        // Unregister just this worktree. A repo-wide `git worktree prune` would
        // also drop worktrees that are only temporarily missing (an unplugged
        // drive), orphaning their commits.
        await gitExec(['worktree', 'remove', '--force', '--force', worktree.checkout], worktree.commonDir)
          .catch(() => undefined);
      }
      // Inspection above read every folder, so permission repair here only ever
      // touches content that was checked — an unreadable folder kept the entry.
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

/** List a directory, or null when it cannot be read. Discovery may treat null
 * as empty; inspection paths must report it and keep the entry. */
async function readDir(dir: string): Promise<Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function findScratchDirs(root: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  const entries = await readDir(root);
  for (const entry of entries ?? []) {
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

export type ActivityScan =
  | { kind: 'recent' }
  | { kind: 'quiet' }
  | { kind: 'blocked'; reason: string };

/**
 * Whether anything in the entry changed after the cutoff. `blocked` means the
 * entry could not be inspected (an unreadable folder, or a tree with more
 * folders than the walk budget); the caller must then keep it rather than read
 * the blind spot as "nothing there".
 */
export async function scanActivitySince(
  entryPath: string,
  cutoffMs: number,
  activityTimeMs: (stat: ActivityStat) => number = defaultActivityTimeMs,
): Promise<ActivityScan> {
  return scanActivity(entryPath, cutoffMs, activityTimeMs, { foldersLeft: MAX_FOLDERS_INSPECTED });
}

async function scanActivity(
  target: string,
  cutoffMs: number,
  activityTimeMs: (stat: ActivityStat) => number,
  budget: { foldersLeft: number },
): Promise<ActivityScan> {
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch {
    return { kind: 'blocked', reason: `could not read ${target}` };
  }
  if (activityTimeMs(stat) > cutoffMs) return { kind: 'recent' };
  if (!stat.isDirectory()) return { kind: 'quiet' };
  if (--budget.foldersLeft < 0) return { kind: 'blocked', reason: `too large to check for recent changes` };
  const entries = await readDir(target);
  if (entries === null) return { kind: 'blocked', reason: `could not read ${target}` };
  for (const entry of entries) {
    if (ACTIVITY_SKIP.has(entry.name) && entry.isDirectory()) continue;
    const nested = await scanActivity(path.join(target, entry.name), cutoffMs, activityTimeMs, budget);
    if (nested.kind !== 'quiet') return nested;
  }
  return { kind: 'quiet' };
}

interface EntryInspection {
  /** Why the entry must be kept, or null when nothing in it is unsaved. */
  unsaved: string | null;
  /** Linked worktrees of repositories outside the entry, to unregister before deleting. */
  linkedWorktrees: { checkout: string; commonDir: string }[];
}

/** A git repository found inside a scratch entry. */
interface RepoInEntry {
  path: string;
  /**
   * A working tree (has `.git`) or a git folder without a work tree of its own:
   * a bare repository, a `--separate-git-dir` store, a deinitialized submodule's
   * folder under `.git/modules`. Git folder commands must name the folder with
   * `--git-dir` because discovery from inside one can settle on a neighbouring
   * repository instead.
   */
  kind: 'worktree' | 'store';
  /**
   * Only consulted when no checkout is configured (`core.worktree` is unset).
   * A submodule store under a work tree's `.git/modules` (or under another
   * such store) then sits in the deinitialized state of that work tree's
   * submodule: the checkout git serves for it is the gitlink inside that work
   * tree, and a checkout elsewhere could only bind through a hand-written
   * `.git` pointer — which git itself never writes into a module store. When
   * `core.worktree` is set it is authoritative and this flag is ignored.
   */
  checkoutInsideByConvention: boolean;
  /** For a nested submodule store, the store of its enclosing submodule. */
  parentStore: string | null;
}

interface RepoSearch {
  repos: RepoInEntry[];
  foldersLeft: number;
  blocked: string | null;
  /**
   * Git folders named by a `.git` file of a checkout found in the entry: that
   * checkout is the store's primary work tree, which proves the store's
   * dependent checkout lives inside the entry.
   */
  gitFileStores: Set<string>;
}

/**
 * Check every git repository inside the entry. A repository whose history is
 * stored inside the entry (a clone, a bare repo, a separate-git-dir store, a
 * submodule store) loses that history when the entry goes, so all of its
 * commits must be reachable from the owning project's refs — and the owning
 * project must hold the objects behind those commits and read none of its own
 * objects from inside the entry. Where git
 * resolves a repository's work tree decides containment: `core.worktree` is
 * resolved and validated, and a git folder with no configured checkout is
 * only cleared once its checkout is proven to be inside the entry — deleting
 * it would otherwise strand a checkout that lives outside. A linked worktree
 * of a repository outside the entry keeps its history, but a detached HEAD
 * there is on no branch and would be orphaned. Worktree cleanliness is
 * checked twice: `git status`, and the flagged files it cannot report.
 */
async function inspectEntry(
  entryPath: string,
  entryStat: Stats,
  ownerRepo: string | null,
  saved: OwnerSurvival | null,
): Promise<EntryInspection> {
  if (!entryStat.isDirectory()) {
    // A plain file (a dump, an archive, a socket) holds no git repositories.
    // `readDir` on it fails with ENOTDIR, which must not read as a failed
    // inspection — old top-level files are exactly what the sweep removes.
    // The owning project's object-graph dependency (an alternates list the
    // file is or leads to) is checked before this, for every entry kind.
    return { unsaved: null, linkedWorktrees: [] };
  }
  const linkedWorktrees: EntryInspection['linkedWorktrees'] = [];
  const entryRealPath = await fs.realpath(entryPath);
  const search: RepoSearch = {
    repos: [], foldersLeft: MAX_FOLDERS_INSPECTED, blocked: null, gitFileStores: new Set<string>(),
  };
  await findRepos(entryPath, search);
  if (search.blocked) return unsaved(search.blocked);
  if (search.foldersLeft < 0) return unsaved(`${entryPath} is too large to check for unsaved git work`);
  // Realpath on both sides: git writes a store's real path into `.git` files,
  // while the walk reports the entry's path as it was spelled.
  const fileMatchedStores = new Set<string>();
  for (const target of search.gitFileStores) fileMatchedStores.add(await realKey(target));
  // Stores whose dependent checkout is inside the entry (or does not exist).
  // Stores of one submodule are only safe once their enclosing store is.
  const checkoutSafe = new Set<string>();
  for (const repo of search.repos) {
    if (repo.kind === 'store') {
      const bare = await repoGit(repo, ['rev-parse', '--is-bare-repository']).catch(() => null);
      if (bare === null) return unsaved(`could not read the git folder at ${repo.path}`);
      const key = await realKey(repo.path);
      if (bare !== 'true') {
        const configured = await configuredCheckout(repo, entryRealPath);
        if (configured.kind === 'unreadable') return unsaved(`could not read the git folder at ${repo.path}`);
        if (configured.kind === 'outside') {
          // The configured checkout runs on this git folder even from outside
          // the entry (its own `.git` pointer names the folder). Deleting the
          // entry would destroy that checkout's HEAD, index and refs even when
          // every commit survives in the owning project.
          return unsaved(`the configured checkout of ${repo.path} is outside this folder at ${configured.target}`);
        }
        if (configured.kind === 'none') {
          // No checkout is configured — the state `git submodule deinit`
          // leaves, or a store a checkout only names through a `.git` pointer
          // (a `--separate-git-dir` clone). Only a checkout proven to live
          // inside the entry — a submodule's gitlink under a work tree found
          // here, or a `.git` file found here naming this store — clears it.
          const parentSafe = repo.parentStore !== null && checkoutSafe.has(await realKey(repo.parentStore));
          if (!repo.checkoutInsideByConvention && !fileMatchedStores.has(key) && !parentSafe) {
            return unsaved(`could not find the checkout of ${repo.path} inside this folder`);
          }
          const staged = await storeStagedChanges(repo);
          if (staged !== null) return unsaved(staged);
        } else {
          // `inside`: the store serves a real checkout inside the entry. Check
          // that working tree fully — unstaged and untracked work there would
          // be deleted with the entry — even when it carries no `.git` pointer
          // of its own and so is never inspected as a repository of its own.
          const content = await checkoutUnsaved(repo, configured.target);
          if (content !== null) return unsaved(content);
        }
      }
      checkoutSafe.add(key);
    } else {
      const configured = await configuredCheckout(repo, entryRealPath);
      if (configured.kind === 'outside') {
        return unsaved(`the configured checkout of ${repo.path} is outside this folder at ${configured.target}`);
      }
      // `unreadable` needs no keep of its own here: a repository git cannot
      // run fails the status check below and keeps the entry, while a linked
      // worktree whose shared config names a missing work tree still runs on
      // its own checkout.
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
      const hidden = await flagHiddenChanges(repo, repo.path);
      if (hidden !== null) return unsaved(hidden);
    }

    const commonDirOutput = await repoGit(repo, ['rev-parse', '--git-common-dir']).catch(() => null);
    if (!commonDirOutput) return unsaved(`could not find the git folder for ${repo.path}`);
    const commonDir = await fs.realpath(path.resolve(repo.path, commonDirOutput)).catch(() => null);
    if (!commonDir) return unsaved(`could not find the git folder for ${repo.path}`);

    if (!isInside(commonDir, entryRealPath)) {
      const orphaned = await repoGit(repo, ['rev-list', 'HEAD', '--not', '--branches', '--tags', '--remotes'])
        .catch(() => null);
      if (orphaned === null) return unsaved(`could not list commits in ${repo.path}`);
      const count = countLines(orphaned);
      if (count > 0) return unsaved(`${count} commit(s) in ${repo.path} are on no branch`);
      linkedWorktrees.push({ checkout: repo.path, commonDir });
      continue;
    }

    const worktrees = await findWorktreeOutside(commonDir, entryRealPath);
    if (worktrees.blocked) return unsaved(worktrees.blocked);
    if (worktrees.outside) {
      return unsaved(`${repo.path} has a linked worktree outside this folder at ${worktrees.outside}`);
    }

    // Every commit reachable from this repository's refs must already survive
    // in the owning project — reachable from one of its refs, because `git gc`
    // deletes objects nothing points at. The whole history is compared, not
    // just ref tips: a tip that survives in the owning project does not carry
    // its ancestors when that project is a shallow clone or is otherwise
    // missing history below the tip, and a stale remote-tracking ref is not
    // another surviving copy either.
    const output = await repoGit(repo, ['rev-list', '--all']).catch(() => null);
    if (output === null) return unsaved(`could not list commits in ${repo.path}`);
    const commits = output.split('\n').map((line) => line.trim()).filter(Boolean);
    if (commits.length === 0) continue;
    if (ownerRepo === null) return unsaved(`commits in ${repo.path} cannot be checked against an owning project`);
    const surviving = saved?.commits ?? null;
    const objectsUnproven = saved?.objectsUnproven ?? null;
    if (surviving === null) return unsaved(`could not compare commits in ${repo.path} with ${ownerRepo}`);
    const notSaved = commits.filter((commit) => !surviving.has(commit)).length;
    if (notSaved > 0) return unsaved(`${notSaved} commit(s) in ${repo.path} are not on any branch of ${ownerRepo}`);
    if (objectsUnproven !== null) {
      // A matching commit ID is not proof of survival: the owner may list every
      // commit while its object graph is missing the trees and blobs under
      // them (the state of a `--filter=blob:none` clone). The contents then
      // live only where they happen to be stored — here — and deleting the
      // entry would destroy the last recoverable copy of that history.
      return unsaved(`${repo.path} may hold the last copy of its contents: ${ownerRepo} ${objectsUnproven}`);
    }
  }
  return { unsaved: null, linkedWorktrees };
}

/** Run a git command in a repository found in the entry. */
function repoGit(repo: RepoInEntry, args: string[]): Promise<string> {
  return gitExec(repo.kind === 'store' ? ['--git-dir', repo.path, ...args] : args, repo.path);
}

async function realKey(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

/**
 * Where git resolves this repository's work tree. `core.worktree` is
 * authoritative — it wins over the checkout the repository was found in and
 * over a `.git` pointer — so containment is decided from the configured
 * checkout path and never inferred from where the git folder sits. Git
 * resolves the path itself (relative values against the git folder, symlinks
 * and all) and reports it even when the checkout is gone; containment then
 * decides, so a checkout behind an unplugged drive keeps the entry. `none`
 * means no checkout is configured — the state `git submodule deinit` leaves.
 */
async function configuredCheckout(
  repo: RepoInEntry,
  entryRealPath: string,
): Promise<
  | { kind: 'none' }
  | { kind: 'inside'; target: string }
  | { kind: 'outside'; target: string }
  | { kind: 'unreadable' }
> {
  let raw: string;
  try {
    // Read the effective value, not just the local config file: `core.worktree`
    // can live in the worktree-specific `config.worktree` (when
    // `extensions.worktreeConfig` is set) or behind an include, neither of
    // which `--local` reads. A store serving an outside checkout would then
    // look unconfigured and be cleared on placement alone.
    raw = await repoGit(repo, ['config', '--get', 'core.worktree']);
  } catch (error) {
    // Exit 1 is git's "not present". Anything else — a configured work tree
    // a cwd-discovered checkout refuses to chdir to, a config git cannot
    // read — cannot be told apart from a checkout we cannot see.
    return (error as { code?: unknown }).code === 1 ? { kind: 'none' } : { kind: 'unreadable' };
  }
  if (raw.length === 0) return { kind: 'none' };
  const target = await repoGit(repo, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (target === null) return { kind: 'unreadable' };
  const real = await fs.realpath(target).catch(() => target);
  return isInside(real, entryRealPath) ? { kind: 'inside', target } : { kind: 'outside', target };
}

/**
 * Uncommitted work `git status` is never shown: status does not compare the
 * working tree of a file marked skip-worktree, and trusts files marked
 * assume-unchanged, so edits under either flag look clean. Every flagged file
 * is therefore compared with its index entry — content via `hash-object`
 * (which applies the filters staging would, and never touches the index) and
 * type and executable mode via the working file's own mode. A flagged file
 * that cannot be read keeps the entry instead.
 */
async function flagHiddenChanges(repo: RepoInEntry, workTree: string): Promise<string | null> {
  const listed = await worktreeGit(repo, workTree, ['ls-files', '-v', '-z']).catch(() => null);
  if (listed === null) return `could not read the index of ${repo.path}`;
  const fileMode = await worktreeGit(repo, workTree, ['config', '--bool', '--get', 'core.fileMode'])
    .then((raw) => raw !== 'false')
    .catch(() => true);
  for (const record of listed.split('\0')) {
    // Records are `<tag> <path>`: `S` is skip-worktree, and `-v` spells
    // assume-unchanged with a lowercase tag (`h`, or `s` for both flags).
    const tag = record.slice(0, 1);
    if (tag !== 'S' && !(tag >= 'a' && tag <= 'z')) continue;
    const file = record.slice(2);
    const index = await worktreeGit(repo, workTree, ['ls-files', '-s', '--', file]).catch(() => null);
    const lines = index === null ? [] : index.split('\n').map((line) => line.trim()).filter(Boolean);
    const fields = lines.length === 1 ? lines[0].split(/\s+/) : [];
    if (fields.length < 2) return `could not read the index of ${repo.path} for ${file}`;
    const worktree = await worktreeGit(repo, workTree, ['hash-object', '--', file]).catch(() => null);
    if (worktree === null || worktree !== fields[1]) {
      return `uncommitted changes in ${repo.path} hidden by skip-worktree or assume-unchanged: ${file}`;
    }
    // The blob matches, but a hidden change can still flip the tracked type or
    // the executable bit without altering the content.
    const stat = await fs.lstat(path.resolve(workTree, file)).catch(() => null);
    if (stat === null) return `could not read ${file} in ${repo.path}`;
    if (modeDiffers(fields[0], gitWorktreeMode(stat), fileMode)) {
      return `uncommitted changes in ${repo.path} hidden by skip-worktree or assume-unchanged: ${file}`;
    }
  }
  return null;
}

/** The mode git records for a working-tree entry. */
function gitWorktreeMode(stat: Stats): string {
  if (stat.isSymbolicLink()) return '120000';
  if (stat.isDirectory()) return '160000';
  return (stat.mode & 0o111) !== 0 ? '100755' : '100644';
}

/**
 * Whether a tracked entry's type or executable bit differs from the working
 * tree. With `core.fileMode` off git ignores the executable bit, so only the
 * type counts then; otherwise the full mode is compared.
 */
function modeDiffers(indexMode: string, worktreeMode: string, fileMode: boolean): boolean {
  const seen = (mode: string): string => (!fileMode && mode === '100755' ? '100644' : mode);
  return seen(indexMode) !== seen(worktreeMode);
}

/**
 * Run a git command against a working tree. A store is bound to the given
 * working tree explicitly (its own `core.worktree` may resolve elsewhere); a
 * work tree found through `.git` resolves its own.
 */
function worktreeGit(repo: RepoInEntry, workTree: string, args: string[]): Promise<string> {
  const full = repo.kind === 'store' ? ['--git-dir', repo.path, '--work-tree', workTree, ...args] : args;
  return gitExec(full, workTree);
}

/**
 * Uncommitted work in the checkout a store is configured to serve * (`core.worktree`). Unlike a work tree found through its own `.git`, this
 * checkout may be the empty remnant `git submodule deinit` leaves: its tracked
 * files are gone from the working tree but still recoverable from the commit
 * the owning project keeps. So a tracked file merely missing from the checkout
 * is not unsaved work — only untracked files, unstaged edits and staged changes
 * count. This still catches the work that would really be lost when the
 * checkout carries no `.git` pointer of its own and is so never inspected as a
 * repository of its own.
 */
async function checkoutUnsaved(repo: RepoInEntry, checkout: string): Promise<string | null> {
  const untracked = await worktreeGit(repo, checkout, ['ls-files', '--others', '--exclude-standard']).catch(() => null);
  // `--diff-filter=d` skips pure worktree deletions (the deinit remnant),
  // keeping only edits and type changes to files still present.
  const unstaged = await worktreeGit(repo, checkout, ['diff-files', '--diff-filter=d', '--name-only']).catch(() => null);
  if (untracked === null || unstaged === null) return `could not read git status in ${repo.path}`;
  if (untracked.trim() !== '' || unstaged.trim() !== '') return `uncommitted changes in ${repo.path}`;
  const staged = await storeStagedChanges(repo);
  if (staged !== null) return staged;
  const hidden = await flagHiddenChanges(repo, checkout);
  if (hidden !== null) return hidden;
  return null;
}

/**
 * Staged but uncommitted work in a git folder with no work tree of its own —
 * the state a deinitialized submodule keeps in its index after its checkout is
 * gone. Unstaged edits cannot be checked without a work tree and do not exist
 * once the checkout is gone.
 */
async function storeStagedChanges(repo: RepoInEntry): Promise<string | null> {
  const staged = await repoGit(repo, ['diff', '--cached', '--name-only', 'HEAD', '--']).catch(() => null);
  if (staged !== null) return staged.length > 0 ? `uncommitted changes in ${repo.path}` : null;
  // No HEAD yet: everything in the index is uncommitted. A HEAD that exists but
  // an index that cannot be read keeps the entry instead.
  const head = await repoGit(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => null);
  if (head !== null) return `could not read the index of ${repo.path}`;
  const files = await repoGit(repo, ['ls-files']).catch(() => null);
  if (files === null) return `could not read the index of ${repo.path}`;
  return files.length > 0 ? `uncommitted changes in ${repo.path}` : null;
}

function unsaved(reason: string): EntryInspection {
  return { unsaved: reason, linkedWorktrees: [] };
}

/**
 * What the owning project provably keeps alive without the scratch entries:
 * the commits its refs reach, proof that its object graph actually holds the
 * contents of those commits, and the object stores it can read from.
 */
interface OwnerSurvival {
  /**
   * Commits the owning project can keep alive: everything reachable from one
   * of its refs. Objects nothing reaches are deleted by `git gc`, so a commit
   * only counts as saved when the owning project's own refs hold it — a remote
   * behind one of its remote-tracking refs may already be gone. Null when the
   * history cannot be read; entries with commits of their own are then kept.
   */
  commits: Set<string> | null;
  /**
   * Why a matching commit ID does not prove the owner keeps a commit's
   * contents — objects reachable from its refs are missing, or its object
   * graph could not be read — or null when every reachable object is present.
   */
  objectsUnproven: string | null;
  /**
   * Every path the owner's object graph runs through: the object stores it
   * reads objects from, the `objects/info/alternates` files it reads its
   * chain out of, and every link below a store root (where the packed and
   * loose objects themselves are read through), each with both spellings of
   * its path. An entry that holds one — the path itself, or a name the owner
   * must keep resolving to reach it — is part of the owner's own object
   * graph. Null when the chain cannot be read.
   */
  objectStores: ObjectStoresDependency | null;
  /**
   * Resolution spellings already walked for one object-graph path. Every
   * entry under one scratch folder is judged against the same owner, and the
   * filesystem does not change mid-sweep, so the walk is done once.
   */
  spellings: Map<string, string[] | null>;
}

/**
 * The three groups of the owner's object graph dependencies: the object store
 * directories it reads objects from, the `objects/info/alternates` files it
 * reads its chain out of, and the links below the store roots that the packed
 * and loose objects themselves are read through. The alternates files are as
 * necessary as the stores they name: a chain link's list is the only reason
 * the owner can find the stores after it, so a list the entry holds (or a
 * symlink hop its resolution runs through) dies with the entry and the owner's
 * `git log` then fails with `fatal: bad object HEAD` even though every object
 * is untouched. The same holds for any link below a store root — a `pack`
 * folder moved aside and linked back, one `.pack`, a loose-object fanout
 * folder, one loose object: git reads the pack and loose objects through
 * those paths, so a link the entry holds or leads to dies with the entry and
 * the owner's history becomes unreadable while the objects are still there.
 */
interface ObjectStoresDependency {
  stores: ObjectPathDependency[];
  alternates: ObjectPathDependency[];
  contents: ObjectPathDependency[];
}

/**
 * A path the owner's object graph depends on, with the two spellings its
 * survival turns on: the name it is spelled by (symlink components intact,
 * `..` not collapsed — the owner re-resolves that exact name on every git
 * command, so deleting anything it runs through strands the owner even when
 * the objects live elsewhere) and where that name lands (symlinks resolved).
 */
interface ObjectPathDependency {
  named: string;
  real: string;
}

async function loadOwnerSurvival(ownerRepo: string): Promise<OwnerSurvival> {
  const history = await gitExec(['rev-list', '--all'], ownerRepo).catch(() => null);
  const commits = history === null ? null : new Set(history.split('\n').map((line) => line.trim()).filter(Boolean));
  // `--missing=print` lists every object the owner's refs reach and prints `?`
  // for each one its stores do not hold — passively, unlike `cat-file`, which
  // a promisor remote would answer by fetching the very objects in question. A
  // commit ID alone proves nothing about the contents under it: a
  // `--filter=blob:none` owner lists every commit while its historical blobs
  // can exist only in a scratch copy.
  const objects = await gitExec(['rev-list', '--objects', '--all', '--missing=print'], ownerRepo).catch(() => null);
  const objectsUnproven = objects === null
    ? 'has an object graph that could not be read'
    : objects.split('\n').some((line) => line.startsWith('?'))
      ? 'is missing objects from its own history'
      : null;
  return {
    commits,
    objectsUnproven,
    objectStores: await loadObjectStores(ownerRepo),
    spellings: new Map<string, string[] | null>(),
  };
}

/** Git's C-style escapes (`unquote_c_style`) as bytes: `\a \b \f \n \r \t \v \\ \"`. */
const C_STYLE_ESCAPES: Record<number, number> = {
  0x61: 0x07, // \a
  0x62: 0x08, // \b
  0x66: 0x0c, // \f
  0x6e: 0x0a, // \n
  0x72: 0x0d, // \r
  0x74: 0x09, // \t
  0x76: 0x0b, // \v
  0x5c: 0x5c, // \\
  0x22: 0x22, // \"
};

/** The bytes of one alternates line's name in the filesystem encoding (UTF-8 here), or null when they are no name this reader can represent. */
function decodeName(bytes: Buffer): string | null {
  if (bytes.length === 0 || bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One `objects/info/alternates` record, decoded the way git reads it — as
 * bytes, never as characters: a raw line up to the end of the line (spaces,
 * quotes and all — nothing is trimmed), or a C-quoted string (`\a \b \f \n
 * \r \t \v \\ \"` and up to three octal digits, each escape producing the
 * BYTE it names — `caf\303\251` is the five bytes of `café`, not the
 * characters `cafÃ©`) with only whitespace after the closing quote. The bytes
 * become a name in the filesystem encoding; `undefined` is a blank line,
 * which names no store. `null` is a record this reader cannot decode — an
 * unsupported escape, a truncated quote, bytes that are no name in the
 * filesystem encoding: it may name any store at all, so the caller must fail
 * closed instead of guessing. A record read as the wrong characters invents
 * a path that does not exist, and the ENOENT under that invented name ends
 * the chain as if it were over.
 */
function decodeAlternatesRecord(line: Buffer): string | null | undefined {
  if (line.length === 0) return undefined;
  if (line[0] !== 0x22) return decodeName(line);
  const name: number[] = [];
  let index = 1;
  for (; index < line.length; index += 1) {
    const byte = line[index];
    if (byte === 0x22) {
      if (line.subarray(index + 1).toString('latin1').trim().length > 0) return null;
      return decodeName(Buffer.from(name));
    }
    if (byte !== 0x5c) {
      name.push(byte);
      continue;
    }
    index += 1;
    const escape = line[index];
    if (escape === undefined) return null;
    const simple = C_STYLE_ESCAPES[escape];
    if (simple !== undefined) {
      name.push(simple);
      continue;
    }
    if (escape < 0x30 || escape > 0x37) return null;
    let value = escape - 0x30;
    let digits = 1;
    while (digits < 3 && index + 1 < line.length && line[index + 1] >= 0x30 && line[index + 1] <= 0x37) {
      index += 1;
      value = value * 8 + (line[index] - 0x30);
      digits += 1;
    }
    // Git stores the byte the digits name (`*dst++ = octal`), truncating
    // values past 0xFF; a truncated NUL then fails closed above.
    name.push(value & 0xff);
  }
  return null;
}

/** Split raw alternates bytes into records: one per line, the trailing newline (byte 0x0A) excluded. */
function splitRecordLines(raw: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0a) {
      lines.push(raw.subarray(start, index));
      start = index + 1;
    }
  }
  lines.push(raw.subarray(start));
  return lines;
}

/**
 * Every path the owner's object graph runs through, following
 * `objects/info/alternates` chains — a chain can run through stores outside
 * the owner and still end inside an entry. Relative names resolve against the
 * objects directory that names them (git's own rule), and each path keeps
 * both the spelling it is named by and where that spelling lands. The
 * alternates files themselves are recorded too: git reads the chain out of
 * `<store>/info/alternates` on every command — at the owner's own store and
 * at every chained store alike — so that file, and every lookup its
 * resolution runs through, is as necessary as the store the chain reaches.
 * So is every link below a store root: the packed and loose objects are read
 * through the paths sitting there (a `pack` folder, one `.pack`, a
 * loose-object fanout, one loose object), each recorded where it is spelled
 * and where it lands.
 * A file that cannot be read ends the chain there exactly as git sees it
 * (`ENOENT`/`ENOTDIR` is the normal "no alternates here"), while a record
 * git's quoting cannot decode makes the whole chain unreadable. Null when any
 * link cannot be read: independence from the entries can then not be proven,
 * and any entry might hold a store, the list that names it, or the objects
 * read through it.
 */
async function loadObjectStores(ownerRepo: string): Promise<ObjectStoresDependency | null> {
  const objectsDir = await gitExec(['rev-parse', '--git-path', 'objects'], ownerRepo).catch(() => null);
  if (objectsDir === null) return null;
  const stores: ObjectPathDependency[] = [];
  const alternates: ObjectPathDependency[] = [];
  const contents: ObjectPathDependency[] = [];
  const seen = new Set<string>();
  const budget = { foldersLeft: MAX_FOLDERS_INSPECTED, linksLeft: MAX_OBJECT_STORE_LINKS };
  const pending: { named: string; depth: number }[] = [
    { named: path.resolve(ownerRepo, objectsDir), depth: 0 },
  ];
  while (pending.length > 0) {
    const store = pending.pop();
    if (store === undefined) continue;
    if (store.depth > MAX_ALTERNATE_CHAIN_DEPTH) return null;
    const real = await realKey(store.named);
    const key = `${store.named}\0${real}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stores.push({ named: store.named, real });
    // Every link below this store root is where the packed and loose objects
    // behind it are actually read from — the owner's history dies with one the
    // entry holds, even though the store root itself sits outside.
    const linked = await loadStoreContents(store.named, budget);
    if (linked === null) return null;
    contents.push(...linked);
    const alternatesNamed = `${store.named}/info/alternates`;
    let raw: Buffer;
    try {
      // Read through the named spelling: it must keep resolving for the owner,
      // and `..` in it runs through the components it pops out of. The bytes
      // are read raw and decoded record by record, exactly as git reads them.
      raw = await fs.readFile(alternatesNamed);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // No alternates here is the normal case; anything else cannot be told
      // apart from a link that would name more stores.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return null;
    }
    // The list was read successfully, so the owner must keep resolving this
    // exact path — the file itself, the `info` folder, and every symlink hop
    // between them — on every git command. Record it like a store.
    alternates.push({ named: alternatesNamed, real: await realKey(alternatesNamed) });
    for (const line of splitRecordLines(raw)) {
      const name = decodeAlternatesRecord(line);
      if (name === null) return null;
      if (name === undefined) continue;
      // The join is kept uncollapsed so the next spelling still shows every
      // component the owner's next resolution runs through — `..` included,
      // which in a real path pops out of a directory it may only reach through
      // a symlink.
      pending.push({
        named: path.isAbsolute(name) ? name : `${store.named}/${name}`,
        depth: store.depth + 1,
      });
    }
  }
  return { stores, alternates, contents };
}

/**
 * Every symlink below one object store root: the packed and loose objects
 * themselves live behind such paths — a `pack` folder moved aside and linked
 * back, one `.pack`, a loose-object fanout folder, one loose object — and the
 * owner reads its history through them on every command, so each link is as
 * necessary as the store root it sits under. Each is recorded with the
 * spelling the store's names run through (symlink components intact) and
 * where that spelling lands. Directory links are followed too — a link can
 * lead to a folder that links back into an entry — with every folder reached
 * by any spelling visited once, so a link cycle cannot walk forever. Null
 * when the contents cannot be fully read: which paths the owner reads its
 * objects through is then unproven and any entry might hold one.
 */
async function loadStoreContents(
  storeNamed: string,
  budget: { foldersLeft: number; linksLeft: number },
): Promise<ObjectPathDependency[] | null> {
  const contents: ObjectPathDependency[] = [];
  const visited = new Set<string>();
  const pending = [storeNamed];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (dir === undefined) continue;
    const real = await fs.realpath(dir).catch(() => null);
    // A spelling that cannot be resolved is not walked further: for the store
    // root itself it is already recorded and checked as a store (a resolution
    // that cannot be finished fails closed there), and a link below it is
    // recorded as a dependency with its own resolution walked the same way.
    if (real === null) continue;
    if (visited.has(real)) continue;
    visited.add(real);
    if (--budget.foldersLeft < 0) return null;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing sits below a path that is not a readable folder (no store
      // root, a link to a file); anything else may hide links that name the
      // only copy of the owner's objects.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return null;
    }
    for (const entry of entries) {
      const named = joinSpelling(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (budget.linksLeft <= 0) return null;
        budget.linksLeft -= 1;
        contents.push({ named, real: await realKey(named) });
      }
      // A directory link is both a dependency and a way to reach more of them;
      // `readdir` on a link to a file answers ENOTDIR above and stops there.
      if (entry.isSymbolicLink() || entry.isDirectory()) pending.push(named);
    }
  }
  return contents;
}

/**
 * Whether the entry holds anything the owning project's object graph depends
 * on, and so must outlive it: a store the entry contains (resolved
 * containment — the objects are read from inside), an alternates list the
 * entry contains or is (the metadata the chain is read out of, plain-file
 * entries included), a link below a store root the entry contains or leads to
 * (where the packed and loose objects themselves are read through — a `pack`
 * folder, one `.pack`, a loose-object fanout, one loose object), or any path
 * spelling the owner's resolution of one of those runs through (lexical
 * containment — every git command re-resolves that name, so a symlink the
 * entry holds is as necessary as the store, list or object path it
 * reaches, and a `..` in the name runs through the folder it pops out of).
 * The resolution is walked hop by hop,
 * because a name can run through the entry only where an intermediate symlink
 * resolution touches it: alias to entry to symlink to a durable store outside
 * still dies with the entry, while the name's lexical spelling and its final
 * realpath never touch it. Checked before any entry is removed — folder,
 * symlink and plain-file entries alike. A resolution that cannot be walked
 * fails closed: independence from the entry is then unproven.
 */
async function ownerObjectStoreDependency(
  entryPath: string,
  ownerRepo: string | null,
  saved: OwnerSurvival | null,
): Promise<string | null> {
  if (ownerRepo === null || saved === null) return null;
  if (saved.objectStores === null) return `could not read the object stores of ${ownerRepo}`;
  const entryRealPath = await fs.realpath(entryPath).catch(() => entryPath);
  // The entry's own node in every spelling the walk can surface: as named,
  // with `.` and `..` collapsed, fully resolved (a symlink entry resolves to
  // its target — kept deliberately: the target's stores and alternates lists
  // must survive the unlink), and with the parent resolved but the entry's own
  // name left in place — the spelling an intermediate symlink hop lands on for
  // a folder and a link entry alike.
  const entrySpellings = [
    entryPath,
    path.resolve(entryPath),
    entryRealPath,
    joinSpelling(
      await fs.realpath(path.dirname(entryPath)).catch(() => path.dirname(entryPath)),
      path.basename(entryPath),
    ),
  ];
  for (const group of [
    {
      paths: saved.objectStores.stores,
      reason: `the owning project ${ownerRepo} reads objects from inside this folder`,
    },
    {
      paths: saved.objectStores.alternates,
      reason: `the owning project ${ownerRepo} reads its object store links from inside this folder`,
    },
    {
      // Checked after the alternates lists so a symlinked list — which both
      // groups track — reports as the list it is rather than as contents.
      paths: saved.objectStores.contents,
      reason: `the owning project ${ownerRepo} reads its object store contents from inside this folder`,
    },
  ]) {
    for (const dependency of group.paths) {
      if (isInside(dependency.real, entryRealPath)) {
        return group.reason;
      }
      const spellings = await resolutionSpellingsCached(saved, dependency.named);
      if (spellings === null) return `could not resolve the object stores of ${ownerRepo}`;
      for (const spelling of [dependency.named, path.resolve(dependency.named), ...spellings]) {
        for (const entry of entrySpellings) {
          if (namedPathTraverses(spelling, entry)) {
            return group.reason;
          }
        }
      }
    }
  }
  return null;
}

/** `resolutionSpellings`, walked once per path and shared by every entry judged against the same owner. */
async function resolutionSpellingsCached(
  saved: OwnerSurvival,
  rawPath: string,
): Promise<string[] | null> {
  const cached = saved.spellings.get(rawPath);
  if (cached !== undefined) return cached;
  const spellings = await resolutionSpellings(rawPath);
  saved.spellings.set(rawPath, spellings);
  return spellings;
}

/**
 * Every path spelling the owner's kernel resolution of `rawPath` runs through,
 * symlinks followed hop by hop: the lookup spelling of each component (`..`
 * spellings included — a pop still runs through the folder it pops out of),
 * and after every hop the spelling of the link's target looked up component by
 * component. Removing anything one of these spellings runs through breaks the
 * name even when its landing is elsewhere — a link's target can spell a path
 * through the entry while both ends of the name sit outside it. Null when the
 * walk cannot be finished — a component that cannot be read, a symlink loop,
 * too many hops, or a name that is not absolute — because independence from
 * the entries is then unproven.
 */
async function resolutionSpellings(rawPath: string): Promise<string[] | null> {
  if (!path.isAbsolute(rawPath)) return null;
  const spellings: string[] = [];
  const landed = await lookupSpellings(path.parse(rawPath).root, pathSegments(rawPath), 0, spellings);
  return landed === null ? null : spellings;
}

/**
 * The lookup spellings touched resolving `segments` in `dir`, or null when the
 * walk fails. Returns the resolved spelling of the landing — where a
 * remaining `..` pops out of, and where later segments are looked up.
 */
async function lookupSpellings(
  dir: string,
  segments: string[],
  hops: number,
  out: string[],
): Promise<string | null> {
  let current = dir;
  for (const segment of segments) {
    if (segment === '.') continue;
    if (segment === '..') {
      out.push(joinSpelling(current, '..'));
      current = path.dirname(current);
      continue;
    }
    const next = joinSpelling(current, segment);
    out.push(next);
    let stat: Stats;
    try {
      stat = await fs.lstat(next);
    } catch {
      return null;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (hops >= MAX_SYMLINK_HOPS) return null;
    const target = await fs.readlink(next).catch(() => null);
    if (target === null) return null;
    // The target is walked component by component from where the link sits
    // (relative) or from its root (absolute) — every lookup in it is a
    // spelling the owner must keep resolving.
    const landed = await lookupSpellings(
      path.isAbsolute(target) ? path.parse(target).root : current,
      pathSegments(target),
      hops + 1,
      out,
    );
    if (landed === null) return null;
    current = landed;
  }
  return current;
}

/** The meaningful components of a path: separators dropped, `.` and `..` kept for the walk to resolve. */
function pathSegments(rawPath: string): string[] {
  const root = path.parse(rawPath).root;
  return rawPath.slice(root.length)
    .split(path.sep === '/' ? /\// : /[\\/]/)
    .filter((segment) => segment.length > 0);
}

/** Join a lookup spelling without collapsing `.` or `..` — the owner must keep resolving the spelled components. */
function joinSpelling(dir: string, segment: string): string {
  if (dir === '') return segment;
  return dir.endsWith('/') || dir.endsWith(path.sep) ? `${dir}${segment}` : `${dir}/${segment}`;
}

/**
 * Whether `dir` sits along `rawPath` as the owner spells it: every path
 * segment of `dir` matches the same leading segment of `rawPath`. `..`
 * segments are left in place — the raw spelling, not its normalization, is
 * what the owner must keep resolving, and a `..` still runs through the
 * component it pops out of — while `.` segments name the same folder and drop
 * out of the comparison.
 */
function namedPathTraverses(rawPath: string, dir: string): boolean {
  const walk = rawPath.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== '.');
  const target = dir.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== '.');
  return target.length <= walk.length && target.every((segment, index) => segment === walk[index]);
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
 * another checkout (an ignored `vendor/` clone, a `node_modules/` dependency
 * checkout, a `.worktrees/` worktree, a submodule) and submodule stores kept
 * under `.git/modules` after their checkout is deinitialized. Symlinks are not
 * followed. `foldersLeft` going negative means the walk stopped early.
 */
async function findRepos(dir: string, search: RepoSearch): Promise<void> {
  if (search.blocked || --search.foldersLeft < 0) return;
  const entries = await readDir(dir);
  if (entries === null) {
    search.blocked = `could not read ${dir}`;
    return;
  }
  const names = new Set(entries.map((entry) => entry.name));
  const gitEntry = entries.find((entry) => entry.name === '.git');
  if (gitEntry) {
    search.repos.push({ path: dir, kind: 'worktree', checkoutInsideByConvention: false, parentStore: null });
    if (gitEntry.isDirectory()) {
      await findModuleStores(path.join(dir, '.git'), search, true);
    } else {
      // A `.git` file names this checkout's git folder. Recording it lets a
      // store elsewhere in the entry prove its checkout lives in here — the
      // other pointer (store to checkout) is not written anywhere git keeps.
      const pointer = (await fs.readFile(path.join(dir, '.git'), 'utf-8').catch(() => '')).trim();
      if (pointer.startsWith('gitdir:')) {
        const target = pointer.slice('gitdir:'.length).trim();
        if (target) search.gitFileStores.add(path.resolve(dir, target));
      }
    }
  } else if (names.has('HEAD') && names.has('objects') && names.has('refs')) {
    search.repos.push({ path: dir, kind: 'store', checkoutInsideByConvention: false, parentStore: null });
    await findModuleStores(dir, search, false);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    await findRepos(path.join(dir, entry.name), search);
    if (search.foldersLeft < 0) return;
  }
}

/**
 * Submodule stores under `gitDir/modules`: each is a full git folder of its
 * own and can hold the only copy of a submodule's commits after `git submodule
 * deinit` emptied its checkout. A submodule name may contain `/`, so namespace
 * folders can sit above a store, and nested submodules of a submodule live in
 * its own `modules/` folder.
 */
async function findModuleStores(gitDir: string, search: RepoSearch, checkoutInsideByConvention: boolean): Promise<void> {
  await findModuleStoresIn(path.join(gitDir, 'modules'), gitDir, search, checkoutInsideByConvention);
}

async function findModuleStoresIn(
  dir: string,
  parentStore: string | null,
  search: RepoSearch,
  checkoutInsideByConvention: boolean,
): Promise<void> {
  if (search.blocked || --search.foldersLeft < 0) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    search.blocked = `could not read ${dir}`;
    return;
  }
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('HEAD') && names.has('objects') && names.has('refs')) {
    search.repos.push({ path: dir, kind: 'store', checkoutInsideByConvention, parentStore });
    await findModuleStoresIn(path.join(dir, 'modules'), dir, search, checkoutInsideByConvention);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await findModuleStoresIn(path.join(dir, entry.name), parentStore, search, checkoutInsideByConvention);
    if (search.foldersLeft < 0) return;
  }
}

/**
 * A worktree registered in `commonDir` whose checkout still exists outside the
 * entry, or a reason the registration cannot be read or resolved (which keeps
 * the entry: an unreadable `gitdir` pointer, or a checkout behind a sealed or
 * unplugged folder, might name a real checkout anywhere — one this shared
 * repository still supports).
 */
async function findWorktreeOutside(
  commonDir: string,
  entryRealPath: string,
): Promise<{ outside: string | null; blocked: string | null }> {
  const dir = path.join(commonDir, 'worktrees');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { outside: null, blocked: null };
    return { outside: null, blocked: `could not read ${dir}` };
  }
  for (const worktree of entries) {
    const gitdirFile = path.join(dir, worktree.name, 'gitdir');
    let pointer: string;
    try {
      pointer = (await fs.readFile(gitdirFile, 'utf-8')).trim();
    } catch {
      return { outside: null, blocked: `could not read ${gitdirFile}` };
    }
    if (!pointer) return { outside: null, blocked: `could not read the worktree registration at ${gitdirFile}` };
    const checkoutPath = path.dirname(path.resolve(commonDir, pointer));
    let checkout: string;
    try {
      checkout = await fs.realpath(checkoutPath);
    } catch {
      return { outside: null, blocked: `could not resolve the worktree at ${checkoutPath}` };
    }
    if (!isInside(checkout, entryRealPath)) return { outside: checkout, blocked: null };
  }
  return { outside: null, blocked: null };
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
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(target, entry.name));
  }
}
