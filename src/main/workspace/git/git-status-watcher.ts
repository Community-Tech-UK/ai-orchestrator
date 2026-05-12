/**
 * GitStatusWatcher — main-process side of Phase 2b auto-refresh.
 *
 * Watches a configurable set of git repositories and emits a debounced
 * `status-changed` event whenever the state visible to `git status` could
 * have changed. The Source Control panel subscribes via IPC and triggers
 * a targeted refresh of the affected repo.
 *
 * Four trigger surfaces (per the Phase 2 plan, item 4 rev2):
 *
 *   1. Per-worktree gitdir — `<gitdir>/index`, `<gitdir>/HEAD`,
 *      `<gitdir>/logs/HEAD`. Catches `git add`, commits, branch checkouts.
 *   2. Common gitdir — `<commonDir>/refs/heads/*`, `<commonDir>/refs/remotes/*`,
 *      `<commonDir>/packed-refs`. Catches branch creation/deletion,
 *      remote-tracking updates after fetches (drives ahead/behind chips).
 *   3. Working tree — debounced, gitignore-aware via the existing
 *      `FileWatcherManager`. Catches unstaged edits (the most common
 *      case, e.g. Claude editing files in another window).
 *
 * **Worktree correctness**: this app creates linked worktrees via
 * `git worktree add` (see `worktree-manager.ts:123`). In a linked
 * worktree `<repo>/.git` is a FILE pointing at
 * `<main-gitdir>/worktrees/<name>/`. The per-worktree index/HEAD live
 * inside that linked gitdir, not at `<repo>/.git/index`. We resolve
 * the actual paths via `git rev-parse --git-dir --git-common-dir` per
 * repo; for non-worktree repos both commands return `<repo>/.git`.
 */

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as chokidar from 'chokidar';
import { getLogger } from '../../logging/logger';
import { getFileWatcherManager, type FileWatcherManager } from '../watcher/file-watcher';

const execFileAsync = promisify(execFile);
const logger = getLogger('GitStatusWatcher');

/**
 * Why the status changed. Useful for the renderer to decide what to
 * re-fetch (e.g. ahead/behind chips only need a refetch on `remotes` /
 * `refs` / `packed-refs`; the file list needs a refetch on any reason).
 */
export type StatusChangeReason =
  | 'index'        // <gitdir>/index — staged changes (git add / git restore --staged)
  | 'head'         // <gitdir>/HEAD or logs/HEAD — branch checkout / commit
  | 'refs'         // <commonDir>/refs/heads/* — branch creation/move
  | 'remotes'      // <commonDir>/refs/remotes/* — fetch landed
  | 'packed-refs'  // <commonDir>/packed-refs — pack rewrite
  | 'worktree';    // working tree file — unstaged edit

export interface GitStatusChangedEvent {
  repoPath: string;
  reason: StatusChangeReason;
  timestamp: number;
}

interface RepoWatch {
  repoPath: string;
  gitDir: string;
  commonDir: string;
  gitDirWatcher: chokidar.FSWatcher | null;
  commonDirWatcher: chokidar.FSWatcher | null;
  workTreeSessionId: string | null;
}

/**
 * Default debounce — coalesces rapid-fire events from the same repo +
 * reason into a single emission. 250ms is enough to suppress
 * keystroke-rate worktree events while still feeling instant for the
 * user.
 */
const DEFAULT_DEBOUNCE_MS = 250;

export interface GitStatusWatcherOptions {
  /** Override the per-(repo, reason) debounce window. */
  debounceMs?: number;
  /** Inject a non-default `FileWatcherManager` for tests. */
  fileWatcher?: FileWatcherManager;
  /**
   * Override how per-repo gitdirs are resolved. Tests inject a stub so
   * the linked-worktree wiring can be exercised without spawning real
   * `git worktree add` setups. Production code passes `undefined` and
   * gets the live `resolveGitDirs` implementation.
   */
  resolveGitDirs?: (repoPath: string) => Promise<{ gitDir: string; commonDir: string } | null>;
}

/**
 * Resolve a repo's per-worktree gitdir and common gitdir.
 *
 * Exported for tests. For non-worktree repos both return `<repo>/.git`;
 * for linked worktrees the gitdir is `<main>/.git/worktrees/<name>`
 * and the common dir is `<main>/.git`.
 *
 * Returns `null` if git is unavailable or the path isn't a repo.
 */
export async function resolveGitDirs(
  repoPath: string,
  execGit: typeof execFileAsync = execFileAsync,
): Promise<{ gitDir: string; commonDir: string } | null> {
  try {
    const [gitDirResult, commonDirResult] = await Promise.all([
      execGit('git', ['rev-parse', '--git-dir'], { cwd: repoPath, encoding: 'utf-8' }),
      execGit('git', ['rev-parse', '--git-common-dir'], { cwd: repoPath, encoding: 'utf-8' }),
    ]);
    const gitDir = path.resolve(repoPath, String(gitDirResult.stdout).trim());
    const commonDir = path.resolve(repoPath, String(commonDirResult.stdout).trim());
    return { gitDir, commonDir };
  } catch (err) {
    logger.warn('resolveGitDirs failed', { repoPath, error: (err as Error).message });
    return null;
  }
}

export class GitStatusWatcher extends EventEmitter {
  private repoWatches = new Map<string, RepoWatch>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly fileWatcher: FileWatcherManager;
  private readonly resolveGitDirsFn: (repoPath: string) => Promise<{ gitDir: string; commonDir: string } | null>;
  /**
   * Mapping from FileWatcherManager session ID → repo path so the
   * single 'change' listener on the file watcher can route events
   * to the right repo.
   */
  private sessionToRepo = new Map<string, string>();
  private fileWatcherHandler: ((sessionId: string) => void) | null = null;

  /**
   * Serialization chain for `setRepos()`. Without this, two rapid
   * calls (e.g. user switches instance twice before the first ack
   * lands) can both observe an empty `repoWatches`, both skip
   * teardown, and both add watchers — leaving orphan watchers on
   * repos that should no longer be tracked. Chaining each call onto
   * the previous makes last-call-wins the actual final state.
   */
  private setReposChain: Promise<void> = Promise.resolve();

  constructor(opts: GitStatusWatcherOptions = {}) {
    super();
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.fileWatcher = opts.fileWatcher ?? getFileWatcherManager();
    this.resolveGitDirsFn = opts.resolveGitDirs ?? resolveGitDirs;
  }

  /**
   * Replace the set of watched repos. Repos in `repoPaths` that are
   * not already being watched get a fresh watcher; repos being watched
   * that are no longer in the set get torn down. Existing watches for
   * repos in both sets are left alone (no churn on a refresh that
   * doesn't change the topology).
   */
  async setRepos(repoPaths: string[]): Promise<void> {
    // Serialize so concurrent calls don't race on `repoWatches`.
    // We swallow errors on the chain so a single failure doesn't pin
    // every subsequent call; each call still throws/returns normally.
    const next = this.setReposChain.then(() => this.doSetRepos(repoPaths));
    this.setReposChain = next.catch(() => undefined);
    return next;
  }

  private async doSetRepos(repoPaths: string[]): Promise<void> {
    const incoming = new Set(repoPaths);

    // Lazy-bind the FileWatcherManager listener (idempotent).
    this.ensureFileWatcherListener();

    // Tear down removed
    const toRemove: string[] = [];
    for (const repoPath of this.repoWatches.keys()) {
      if (!incoming.has(repoPath)) toRemove.push(repoPath);
    }
    await Promise.all(toRemove.map(p => this.stopWatch(p)));

    // Bring up new ones
    const toAdd = repoPaths.filter(p => !this.repoWatches.has(p));
    await Promise.all(toAdd.map(p => this.startWatch(p)));
  }

  /**
   * Stop all watchers and release resources.
   *
   * Drains the `setReposChain` first so an in-flight `doSetRepos` can't
   * race past us and leave orphan chokidar watchers / file-watcher
   * sessions after we've cleared bookkeeping.
   */
  async stop(): Promise<void> {
    // Wait for any in-flight setRepos to settle. Errors on the chain
    // are already swallowed by the catch in `setRepos()`, so this
    // never throws.
    await this.setReposChain;

    const repoPaths = Array.from(this.repoWatches.keys());
    await Promise.all(repoPaths.map(p => this.stopWatch(p)));

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.fileWatcherHandler) {
      this.fileWatcher.off('change', this.fileWatcherHandler);
      this.fileWatcherHandler = null;
    }
  }

  /** Currently-watched repo paths (test introspection). */
  watchedRepos(): string[] {
    return Array.from(this.repoWatches.keys());
  }

  // ---------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------

  private async startWatch(repoPath: string): Promise<void> {
    const dirs = await this.resolveGitDirsFn(repoPath);
    if (!dirs) {
      logger.debug('startWatch: skipping non-repo', { repoPath });
      return;
    }
    const { gitDir, commonDir } = dirs;

    // -----------------------------------------------------------------
    // 1. Per-worktree gitdir watcher
    //    Files may not exist yet (a fresh repo has no index until first
    //    add). chokidar handles non-existent paths gracefully — it just
    //    watches the parent dir and emits an 'add' event when the file
    //    appears.
    // -----------------------------------------------------------------
    const gitDirPaths = [
      path.join(gitDir, 'index'),
      path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'logs', 'HEAD'),
    ];
    const gitDirWatcher = chokidar.watch(gitDirPaths, {
      ignoreInitial: true,
      persistent: true,
      // Use polling fallback only if needed; native FS events are fine
      // for these small known files.
      atomic: 100, // many tools (incl. git) write atomically via rename
    });

    const onGitDirEvent = (filePath: string) => {
      const reason: StatusChangeReason = path.basename(filePath) === 'index' ? 'index' : 'head';
      this.emitDebounced(repoPath, reason);
    };
    gitDirWatcher.on('change', onGitDirEvent);
    gitDirWatcher.on('add', onGitDirEvent);
    gitDirWatcher.on('unlink', onGitDirEvent);
    gitDirWatcher.on('error', err =>
      logger.warn('gitdir watcher error', { repoPath, error: errorMessage(err) }),
    );

    // -----------------------------------------------------------------
    // 2. Common-dir watcher (refs, packed-refs)
    // -----------------------------------------------------------------
    const commonDirPaths = [
      path.join(commonDir, 'refs'),
      path.join(commonDir, 'packed-refs'),
    ];
    const commonDirWatcher = chokidar.watch(commonDirPaths, {
      ignoreInitial: true,
      persistent: true,
      depth: 99,
    });
    const onCommonDirEvent = (filePath: string) => {
      const relPath = path.relative(commonDir, filePath);
      let reason: StatusChangeReason = 'refs';
      if (relPath === 'packed-refs') reason = 'packed-refs';
      else if (relPath.startsWith(`refs${path.sep}remotes${path.sep}`)) reason = 'remotes';
      this.emitDebounced(repoPath, reason);
    };
    commonDirWatcher.on('change', onCommonDirEvent);
    commonDirWatcher.on('add', onCommonDirEvent);
    commonDirWatcher.on('unlink', onCommonDirEvent);
    commonDirWatcher.on('error', err =>
      logger.warn('common-dir watcher error', { repoPath, error: errorMessage(err) }),
    );

    // -----------------------------------------------------------------
    // 3. Working-tree watcher via FileWatcherManager
    //    We don't subscribe to the watcher per repo; the single listener
    //    on `this.fileWatcher` routes by session ID via sessionToRepo.
    // -----------------------------------------------------------------
    const session = await this.fileWatcher.watch(repoPath, {
      useGitignore: true,
      depth: 99,
      ignoreInitial: true,
      debounceMs: this.debounceMs,
    });
    this.sessionToRepo.set(session.id, repoPath);

    this.repoWatches.set(repoPath, {
      repoPath,
      gitDir,
      commonDir,
      gitDirWatcher,
      commonDirWatcher,
      workTreeSessionId: session.id,
    });

    logger.debug('startWatch: now watching', { repoPath, gitDir, commonDir });
  }

  private ensureFileWatcherListener(): void {
    if (this.fileWatcherHandler) return;
    this.fileWatcherHandler = (sessionId: string) => {
      const repoPath = this.sessionToRepo.get(sessionId);
      if (repoPath) {
        this.emitDebounced(repoPath, 'worktree');
      }
    };
    this.fileWatcher.on('change', this.fileWatcherHandler);
  }

  private async stopWatch(repoPath: string): Promise<void> {
    const watch = this.repoWatches.get(repoPath);
    if (!watch) return;

    const closes: Promise<unknown>[] = [];
    if (watch.gitDirWatcher) closes.push(watch.gitDirWatcher.close());
    if (watch.commonDirWatcher) closes.push(watch.commonDirWatcher.close());
    if (watch.workTreeSessionId) {
      this.sessionToRepo.delete(watch.workTreeSessionId);
      closes.push(this.fileWatcher.unwatch(watch.workTreeSessionId));
    }
    try {
      await Promise.all(closes);
    } catch (err) {
      logger.warn('stopWatch: close error (ignored)', { repoPath, error: (err as Error).message });
    }

    // Drop pending debounce timers for this repo.
    for (const key of Array.from(this.debounceTimers.keys())) {
      if (key.startsWith(`${repoPath}::`)) {
        clearTimeout(this.debounceTimers.get(key)!);
        this.debounceTimers.delete(key);
      }
    }

    this.repoWatches.delete(repoPath);
    logger.debug('stopWatch: stopped', { repoPath });
  }

  private emitDebounced(repoPath: string, reason: StatusChangeReason): void {
    const key = `${repoPath}::${reason}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      const event: GitStatusChangedEvent = {
        repoPath,
        reason,
        timestamp: Date.now(),
      };
      this.emit('status-changed', event);
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor (matches the codebase pattern: lazy getter +
// reset hook for tests)
// ---------------------------------------------------------------------------

let watcherInstance: GitStatusWatcher | null = null;

export function getGitStatusWatcher(): GitStatusWatcher {
  if (!watcherInstance) {
    watcherInstance = new GitStatusWatcher();
  }
  return watcherInstance;
}

/** Test hook: drop the singleton (and stop its watchers). */
export async function _resetGitStatusWatcherForTesting(): Promise<void> {
  if (watcherInstance) {
    await watcherInstance.stop();
    watcherInstance = null;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}
