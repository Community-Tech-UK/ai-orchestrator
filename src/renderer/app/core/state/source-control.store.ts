/**
 * Source Control Store — single source of truth for the Source Control panel
 * and the header pip.
 *
 * Owns:
 *   - The repo list and per-repo status for the active working directory
 *   - Per-repo expanded state (which sections the user has open)
 *   - The diff-viewer request signal (which file the modal should show)
 *   - The aggregate change count consumed by the header pip
 *
 * **Stale-response protection** — `loadForRoot()` and `refresh()` are
 * non-trivially interleavable. The dashboard's eager-load effect can fire
 * `loadForRoot(rootA)`, then the user picks instance B, firing
 * `loadForRoot(rootB)` while rootA's promises are still in flight. Without
 * protection, rootA's late status callbacks would overwrite rootB's state
 * whenever the two instances happen to share a repo path (common in
 * monorepos / shared work directories).
 *
 * The protection is a monotonic `requestSeq` token: every entry into
 * `refresh()` increments it; every `await` boundary checks the token before
 * mutating signals. Stale results are dropped silently.
 *
 * See `docs/plans/2026-05-12-source-control-phase-2-plan.md` item 3.
 */

import { computed, inject, Injectable, signal } from '@angular/core';
import { VcsIpcService } from '../services/ipc/vcs-ipc.service';
import type {
  DiffViewerRequest,
  FileChange,
  GitStatusResponse,
  RepoState,
} from '../../features/source-control/source-control.types';

/**
 * Result envelope for the store's write-action methods (stageFiles,
 * unstageFiles, …). Keeps the renderer surface minimal — callers
 * primarily want "did it work, and if not, what's the user-visible
 * error".
 */
export interface IpcWriteResult {
  success: boolean;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class SourceControlStore {
  private vcs = inject(VcsIpcService);

  // ---------------------------------------------------------------------
  // Auto-refresh subscription (Phase 2b)
  // ---------------------------------------------------------------------

  /**
   * Unsubscribe function returned by `vcs.onVcsStatusChanged`. Created
   * lazily on first `loadForRoot()` so the IPC bridge is never bound
   * outside Electron (tests / web preview).
   */
  private statusChangedUnsubscribe: (() => void) | null = null;

  /**
   * Whenever a `status-changed` event arrives from the main-process
   * watcher, we re-fetch only that repo's status — much cheaper than
   * a full `refresh()`, and avoids the head-of-line blocking of doing
   * a fresh `vcsFindRepos`. The targeted update goes through the
   * sequence counter check so a concurrent root-switch still wins.
   *
   * **Write-action coalescing (Phase 2d):** when a write action
   * (stage / unstage / commit / push / etc.) is in flight, the
   * watcher will inevitably emit `status-changed` events for events
   * the renderer itself triggered. Refreshing mid-write would race
   * the still-running write against a stale read; instead we coalesce
   * the events into a pending-refresh set keyed by repo path. The
   * `endWrite()` API drains that set with a grace period.
   */
  private ensureStatusSubscription(): void {
    if (this.statusChangedUnsubscribe) return;
    this.statusChangedUnsubscribe = this.vcs.onVcsStatusChanged(event => {
      // Drop events for repos we're not currently tracking (e.g. the
      // user switched roots and the new event set hasn't propagated to
      // the main-process watcher yet).
      if (!this.repos().some(r => r.absolutePath === event.repoPath)) return;

      // Write-token coalescing: a write is mid-flight for this repo.
      // Buffer the event until `endWrite()` drains it.
      if (this.activeWritesByRepo.has(event.repoPath)) {
        this.pendingRefreshAfterWrite.add(event.repoPath);
        return;
      }

      void this.refreshOne(event.repoPath);
    });
  }

  // ---------------------------------------------------------------------
  // Public read-only signals (the component consumes these)
  // ---------------------------------------------------------------------

  readonly repos = signal<RepoState[]>([]);
  readonly isRefreshing = signal(false);
  readonly initialLoad = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly expandedRepos = signal<Set<string>>(new Set());
  readonly diffRequest = signal<DiffViewerRequest | null>(null);
  /**
   * File rows the user has expanded inline (Phase 2c item 5). Keyed by
   * `repoPath::filePath::staged` since the same file can appear in
   * both the staged and unstaged groups, and the two diffs differ.
   *
   * Lives on the store so a `repos.set(...)` from auto-refresh doesn't
   * collapse rows the user is reading. Cleared on root change in
   * `loadForRoot()`.
   */
  readonly expandedFiles = signal<Set<string>>(new Set());

  /**
   * The working directory the last `loadForRoot()` was called with.
   * Exposed so consumers (e.g. tests, telemetry) can tell what the store
   * thinks it's tracking. `null` when the panel should show an empty
   * state.
   */
  readonly activeRoot = signal<string | null>(null);

  /**
   * Aggregate change count across all repos for the active root.
   *
   * Counts staged + unstaged. **Excludes untracked** per the Phase 2
   * plan decision: untracked counts are very noisy if a project
   * under-gitignores generated files (e.g. `dist/`), and the badge is
   * meant to signal "you have committable changes", not "your worktree
   * has files git doesn't know about".
   */
  readonly totalChangeCount = computed(() => {
    let total = 0;
    for (const repo of this.repos()) {
      const s = repo.status;
      if (!s) continue;
      total += s.staged.length + s.unstaged.length;
    }
    return total;
  });

  // ---------------------------------------------------------------------
  // Private — stale-response protection
  // ---------------------------------------------------------------------

  /**
   * Monotonic request counter. Incremented at the start of every
   * `refresh()`; every `await` boundary checks `if (reqId !== this.requestSeq)
   * return` before mutating signals.
   *
   * Together with `activeRoot` this gives us belt-and-braces protection:
   * `requestSeq` catches the case where the same root is refreshed twice
   * (only the most recent result counts); `activeRoot` catches the case
   * where the root changed mid-flight (results for a stale root are
   * dropped even if the seq somehow matches).
   */
  private requestSeq = 0;

  /** The root the last refresh actually ran for (for the auto-expand rule). */
  private lastRefreshedRoot: string | null = null;

  // ---------------------------------------------------------------------
  // Write-token machinery (Phase 2d — items 7+)
  //
  // Long-running writes (stage, unstage, discard, commit, push, …) need
  // to suppress mid-flight `status-changed` refreshes. A naive timeout
  // is wrong — `git push` can run for 30+ seconds and the watcher
  // fires multiple events during that window. Instead each write
  // acquires a token; incoming events for tokened repos are buffered
  // into `pendingRefreshAfterWrite` and replayed when the last token
  // for that repo releases. A short grace period coalesces near-
  // simultaneous releases.
  // ---------------------------------------------------------------------

  /**
   * Per-repo set of active write tokens. A repo with ≥1 active token
   * is "writing" — incoming watcher events are coalesced.
   * Keyed by repo path so writes on different repos don't interfere.
   *
   * Source of truth lives here; `writingRepos` is the reactive
   * projection the template consumes.
   */
  private activeWritesByRepo = new Map<string, Set<symbol>>();

  /**
   * Reactive view of which repos currently have an in-flight write.
   * Updated alongside `activeWritesByRepo` from `beginWrite` /
   * `endWrite`. Exposed as `isWriting(repoPath)` to the component.
   */
  readonly writingRepos = signal<Set<string>>(new Set());

  /**
   * Repos that had a `status-changed` event coalesced while a write
   * was in flight. Drained on the last `endWrite()` for the repo.
   */
  private pendingRefreshAfterWrite = new Set<string>();

  /**
   * Grace period (ms) between the last `endWrite()` for a repo and the
   * coalesced refresh. Allows back-to-back writes (e.g. stage all)
   * without an immediate refresh that would then need to be redone.
   * Exposed as a property so tests can tune it.
   */
  protected readonly writeReleaseGraceMs = 300;

  /** Returns true if this repo currently has ≥1 in-flight write. */
  isWriting(repoPath: string): boolean {
    return this.writingRepos().has(repoPath);
  }

  // ---------------------------------------------------------------------
  // Public mutation API
  // ---------------------------------------------------------------------

  /**
   * Set the working directory the store should track and trigger a load.
   *
   * Called by the dashboard's eager-load effect whenever the eligible
   * instance changes. Passing `null` clears state and the badge.
   */
  async loadForRoot(root: string | null): Promise<void> {
    this.ensureStatusSubscription();
    if (!root) {
      // Bump seq so any in-flight refresh aborts on its next await.
      ++this.requestSeq;
      this.activeRoot.set(null);
      this.repos.set([]);
      this.loadError.set(null);
      this.initialLoad.set(true);
      this.isRefreshing.set(false);
      this.lastRefreshedRoot = null;
      // Drop inline expansions: they belonged to the now-defunct root.
      this.expandedFiles.set(new Set());
      // Stop main-process watchers — nothing to watch.
      void this.vcs.vcsWatchRepos([]);
      return;
    }
    this.activeRoot.set(root);
    return this.refresh(root);
  }

  /**
   * Re-fetch repos + statuses for the active root (or the supplied root).
   *
   * Public so the panel's manual refresh button can call it. Also called
   * internally by `loadForRoot()`. Safe to call multiple times — late
   * results from earlier calls are discarded via the sequence counter.
   */
  async refresh(rootOverride?: string): Promise<void> {
    const root = rootOverride ?? this.activeRoot();
    if (!root) {
      this.repos.set([]);
      this.initialLoad.set(false);
      return;
    }

    const reqId = ++this.requestSeq;

    // Switching to a new working directory? Drop the old repo list so the
    // panel shows the "Scanning…" loading state instead of stale content.
    // Also clear inline expansions — they're keyed by repo path, which
    // is about to change.
    if (root !== this.lastRefreshedRoot) {
      this.repos.set([]);
      this.initialLoad.set(true);
      this.expandedFiles.set(new Set());
    }

    this.isRefreshing.set(true);
    this.loadError.set(null);

    try {
      const findResponse = await this.vcs.vcsFindRepos(root);

      // Stale check #1: did the user switch roots while findRepos was
      // running? If so, drop this entire pass on the floor.
      if (reqId !== this.requestSeq) return;

      if (!findResponse.success) {
        this.loadError.set(findResponse.error?.message ?? 'Failed to scan for repositories');
        this.repos.set([]);
        return;
      }

      const data = findResponse.data as { repositories: string[]; gitAvailable: boolean };
      if (!data.gitAvailable) {
        this.loadError.set('Git is not installed or not on PATH.');
        this.repos.set([]);
        return;
      }

      const repoPaths = data.repositories;
      const isNewRoot = root !== this.lastRefreshedRoot;

      // Build the next repos list. For a new root every entry starts in
      // `loading: true`. For a same-root refresh (manual button or, in
      // Phase 2b, an incoming watcher event) we preserve the previous
      // `status` so the panel doesn't flicker every cell to "loading…"
      // each time a single file changes on disk. The status will be
      // overwritten by the in-flight `vcsGetStatus` calls as they
      // resolve below.
      const previousByPath = isNewRoot
        ? new Map<string, RepoState>()
        : new Map(this.repos().map(r => [r.absolutePath, r]));

      const initialStates: RepoState[] = repoPaths.map(absolute => {
        const previous = previousByPath.get(absolute);
        if (previous) {
          // Keep previous status visible during the refresh; mark loading
          // so the per-row spinner is shown.
          return { ...previous, loading: true };
        }
        return {
          absolutePath: absolute,
          name: absolute.split('/').filter(Boolean).pop() ?? absolute,
          relativePath: relativeFromRoot(root, absolute),
          status: null,
          error: null,
          loading: true,
        };
      });
      this.repos.set(initialStates);

      // Auto-expand all repos when the working directory changes (first
      // load OR project switch). Manual refresh of the same project
      // preserves the user's per-repo collapse choices.
      if (isNewRoot) {
        this.expandedRepos.set(new Set(repoPaths));
      }
      this.lastRefreshedRoot = root;

      // Push the new watch set to the main-process GitStatusWatcher so
      // it can start emitting `vcs:status-changed` for these repos.
      // Fire-and-forget — failures only mean no auto-refresh, never
      // a correctness issue. The store stays usable.
      void this.vcs.vcsWatchRepos(repoPaths);

      // Fan-out status calls; each result is gated on the sequence counter.
      await Promise.all(
        initialStates.map(async repoState => {
          const statusResponse = await this.vcs.vcsGetStatus(repoState.absolutePath);

          // Stale check #2: bail if the user has moved on between
          // findRepos and this status call resolving.
          if (reqId !== this.requestSeq) return;

          this.repos.update(current => {
            const next = [...current];
            const idx = next.findIndex(r => r.absolutePath === repoState.absolutePath);
            if (idx === -1) return current;
            if (statusResponse.success) {
              next[idx] = {
                ...next[idx],
                status: statusResponse.data as GitStatusResponse,
                error: null,
                loading: false,
              };
            } else {
              next[idx] = {
                ...next[idx],
                status: null,
                error: statusResponse.error?.message ?? 'git status failed',
                loading: false,
              };
            }
            return next;
          });
        })
      );
    } finally {
      // Only the most recent refresh clears the loading flags. A stale
      // refresh leaving its finally block must not clear a fresher
      // refresh's flags out from under it.
      if (reqId === this.requestSeq) {
        this.isRefreshing.set(false);
        this.initialLoad.set(false);
      }
    }
  }

  /**
   * Re-fetch ONE repo's status. Used by the auto-refresh subscription
   * — cheaper than a full panel refresh on every file event.
   *
   * Stale-protected via the sequence counter just like `refresh()`: if
   * the user switches roots between the call and the IPC response,
   * the result is dropped.
   */
  async refreshOne(repoPath: string): Promise<void> {
    // Capture the current seq. If a fuller refresh starts between now
    // and the await, our reqId will be stale and we'll bail.
    const reqId = this.requestSeq;

    // Bail early if the repo isn't in our current tracked set (e.g.
    // a stale event for a repo from a previous root).
    if (!this.repos().some(r => r.absolutePath === repoPath)) return;

    const statusResponse = await this.vcs.vcsGetStatus(repoPath);
    if (reqId !== this.requestSeq) return; // stale

    this.repos.update(current => {
      const next = [...current];
      const idx = next.findIndex(r => r.absolutePath === repoPath);
      if (idx === -1) return current;
      if (statusResponse.success) {
        next[idx] = {
          ...next[idx],
          status: statusResponse.data as GitStatusResponse,
          error: null,
          loading: false,
        };
      } else {
        next[idx] = {
          ...next[idx],
          error: statusResponse.error?.message ?? 'git status failed',
          loading: false,
        };
      }
      return next;
    });
  }

  // ---------------------------------------------------------------------
  // Write-token API (Phase 2d) and write actions
  // ---------------------------------------------------------------------

  /**
   * Acquire a write token for `repoPath`. Returns a token that MUST be
   * released via `endWrite()` in a `try/finally`. While ≥1 token is
   * active for a repo, incoming `status-changed` events for that repo
   * are coalesced (one refresh after the last `endWrite()` resolves)
   * instead of triggering a per-event refresh.
   *
   * `reason` is a human-readable tag for telemetry/debugging
   * (`'stage'`, `'unstage'`, `'commit'`, `'push'`, …). Currently unused
   * by the store; retained for future structured logging.
   */
  beginWrite(repoPath: string, reason: string): symbol {
    const token = Symbol(`vcs-write:${reason}`);
    let tokens = this.activeWritesByRepo.get(repoPath);
    if (!tokens) {
      tokens = new Set();
      this.activeWritesByRepo.set(repoPath, tokens);
    }
    const isNew = tokens.size === 0;
    tokens.add(token);
    if (isNew) {
      this.writingRepos.update(set => {
        const next = new Set(set);
        next.add(repoPath);
        return next;
      });
    }
    return token;
  }

  /**
   * Release a write token previously acquired via `beginWrite()`. If
   * this was the last active token for `repoPath`, any coalesced
   * status-changed event for that repo is drained after a short grace
   * period (`writeReleaseGraceMs`). A stale or double-released token
   * is ignored — releasing twice is safe.
   */
  endWrite(repoPath: string, token: symbol): void {
    const tokens = this.activeWritesByRepo.get(repoPath);
    if (!tokens || !tokens.has(token)) return; // stale / double-end
    tokens.delete(token);
    if (tokens.size > 0) return; // other writes still in flight; keep coalescing
    this.activeWritesByRepo.delete(repoPath);
    this.writingRepos.update(set => {
      if (!set.has(repoPath)) return set;
      const next = new Set(set);
      next.delete(repoPath);
      return next;
    });

    // Always do a final refresh — even if the watcher never fired, the
    // write itself definitionally changed the repo's status. (E.g.
    // staging a file that was previously the only unstaged change
    // moves it to staged.) Drain `pendingRefreshAfterWrite` since the
    // coalesced events are about to be reflected anyway.
    this.pendingRefreshAfterWrite.delete(repoPath);
    setTimeout(() => {
      // Bail if the repo is no longer tracked (root switched during
      // the grace period). `refreshOne` also has internal guards
      // (sequence counter) for this.
      if (!this.repos().some(r => r.absolutePath === repoPath)) return;
      void this.refreshOne(repoPath);
    }, this.writeReleaseGraceMs);
  }

  /**
   * Phase 2d — item 7. Stage one or more files in a repo, refreshing
   * that repo's status when the write completes. Errors are surfaced
   * via `loadError` so the panel can show them; the caller can also
   * await the returned promise and inspect `result.success`.
   */
  async stageFiles(repoPath: string, filePaths: string[]): Promise<IpcWriteResult> {
    return this.runWrite('stage', repoPath, () =>
      this.vcs.vcsStageFiles({ workingDirectory: repoPath, filePaths })
    );
  }

  /**
   * Phase 2d — item 7. Unstage one or more files. Only the index side
   * is touched; worktree edits are preserved.
   */
  async unstageFiles(repoPath: string, filePaths: string[]): Promise<IpcWriteResult> {
    return this.runWrite('unstage', repoPath, () =>
      this.vcs.vcsUnstageFiles({ workingDirectory: repoPath, filePaths })
    );
  }

  /**
   * Shared write driver: acquires/releases the write token, surfaces
   * errors on `loadError`, and ensures the targeted `refreshOne` fires
   * on success. Exposed as a protected helper so future write actions
   * (discard, commit, push) can share the same coalescing semantics.
   */
  private async runWrite(
    reason: string,
    repoPath: string,
    op: () => Promise<{ success: boolean; data?: unknown; error?: { message?: string } }>
  ): Promise<IpcWriteResult> {
    this.ensureStatusSubscription();
    const token = this.beginWrite(repoPath, reason);
    try {
      const response = await op();
      if (!response.success) {
        const message = response.error?.message ?? `${reason} failed`;
        this.loadError.set(message);
        return { success: false, error: message };
      }
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.loadError.set(message);
      return { success: false, error: message };
    } finally {
      this.endWrite(repoPath, token);
    }
  }

  // ---------------------------------------------------------------------
  // Repo expansion + diff modal — pure signal mutations, no async
  // ---------------------------------------------------------------------

  isRepoExpanded(absolutePath: string): boolean {
    return this.expandedRepos().has(absolutePath);
  }

  toggleRepo(absolutePath: string): void {
    this.expandedRepos.update(set => {
      const next = new Set(set);
      if (next.has(absolutePath)) next.delete(absolutePath);
      else next.add(absolutePath);
      return next;
    });
  }

  /**
   * Build the stable key for the inline-file expansion set. Staged
   * and unstaged variants of the same path are independent rows.
   */
  static fileExpansionKey(repoPath: string, filePath: string, staged: boolean): string {
    return `${repoPath}::${filePath}::${staged ? 'staged' : 'unstaged'}`;
  }

  isFileExpanded(repoPath: string, filePath: string, staged: boolean): boolean {
    return this.expandedFiles().has(SourceControlStore.fileExpansionKey(repoPath, filePath, staged));
  }

  toggleFileExpansion(repoPath: string, filePath: string, staged: boolean): void {
    const key = SourceControlStore.fileExpansionKey(repoPath, filePath, staged);
    this.expandedFiles.update(set => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  openDiff(repo: RepoState, file: FileChange, staged: boolean): void {
    this.diffRequest.set({
      workingDirectory: repo.absolutePath,
      repoName: repo.name,
      filePath: file.path,
      staged,
    });
  }

  closeDiff(): void {
    this.diffRequest.set(null);
  }

  // ---------------------------------------------------------------------
  // Testing hooks
  // ---------------------------------------------------------------------

  /**
   * Reset all state. Tests call this in `beforeEach` to get a clean
   * store between cases (matches the codebase's singleton-test pattern).
   */
  _resetForTesting(): void {
    ++this.requestSeq; // abort any in-flight async work
    this.repos.set([]);
    this.isRefreshing.set(false);
    this.initialLoad.set(true);
    this.loadError.set(null);
    this.expandedRepos.set(new Set());
    this.expandedFiles.set(new Set());
    this.diffRequest.set(null);
    this.activeRoot.set(null);
    this.lastRefreshedRoot = null;
    this.activeWritesByRepo.clear();
    this.pendingRefreshAfterWrite.clear();
    this.writingRepos.set(new Set());
    if (this.statusChangedUnsubscribe) {
      this.statusChangedUnsubscribe();
      this.statusChangedUnsubscribe = null;
    }
  }

  /** Test hook: snapshot active write tokens per repo. */
  _getActiveWriteRepos(): string[] {
    return Array.from(this.activeWritesByRepo.keys());
  }

  /** Test hook: snapshot pending coalesced refreshes. */
  _getPendingRefreshes(): string[] {
    return Array.from(this.pendingRefreshAfterWrite);
  }
}

/** Pure helper — exported only for tests. */
export function relativeFromRoot(root: string, absolute: string): string {
  if (absolute === root) return '.';
  if (absolute.startsWith(root + '/')) {
    return absolute.slice(root.length + 1);
  }
  return absolute;
}
