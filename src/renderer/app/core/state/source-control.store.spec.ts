/**
 * SourceControlStore tests.
 *
 * The headline test is the **stale-response regression**: a slow refresh
 * for root A must not overwrite state when the user has already switched
 * to root B. Phase 2a's plan flags this as the most important regression
 * the store can introduce; without protection, the header pip and panel
 * counts will silently drift on instance switches.
 *
 * Pattern follows other renderer signal-store tests (TestBed.inject + mock
 * dependencies). No DOM, no zone — pure signals.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SourceControlStore, relativeFromRoot } from './source-control.store';
import { VcsIpcService } from '../services/ipc/vcs-ipc.service';
import type { GitStatusResponse } from '../../features/source-control/source-control.types';

// ---------------------------------------------------------------------------
// Mock factory for the VcsIpcService — each test controls promise resolution
// so we can interleave calls.
// ---------------------------------------------------------------------------

interface PendingFindResponse {
  promise: Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  resolve: (data: { repositories: string[]; gitAvailable: boolean }) => void;
}

interface PendingStatusResponse {
  promise: Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  resolve: (status: GitStatusResponse) => void;
}

function status(branch: string, staged = 0, unstaged = 0, untracked = 0): GitStatusResponse {
  return {
    branch,
    ahead: 0,
    behind: 0,
    staged: Array.from({ length: staged }, (_, i) => ({
      path: `staged-${i}.ts`,
      status: 'modified',
      staged: true,
    })),
    unstaged: Array.from({ length: unstaged }, (_, i) => ({
      path: `unstaged-${i}.ts`,
      status: 'modified',
      staged: false,
    })),
    untracked: Array.from({ length: untracked }, (_, i) => `untracked-${i}.ts`),
    hasChanges: staged + unstaged + untracked > 0,
    isClean: staged + unstaged + untracked === 0,
  };
}

interface PendingWriteResponse {
  resolve: () => void;
  reject: (err: unknown) => void;
  payload: { workingDirectory: string; filePaths: string[] };
  kind: 'stage' | 'unstage';
}

function makeVcsMock() {
  const pendingFinds: PendingFindResponse[] = [];
  const pendingStatuses: PendingStatusResponse[] = [];
  const pendingWrites: PendingWriteResponse[] = [];
  const vcsWatchReposCalls: string[][] = [];
  // We capture the renderer-side subscription so tests can simulate
  // a main-process push of `vcs:status-changed`.
  let statusChangedCallback: ((event: { repoPath: string; reason: string; timestamp: number }) => void) | null = null;

  const vcsFindRepos = vi.fn(() => {
    let resolveFn!: PendingFindResponse['resolve'];
    const promise = new Promise<{ success: boolean; data?: unknown; error?: { message: string } }>(
      resolve => {
        resolveFn = data => resolve({ success: true, data });
      }
    );
    pendingFinds.push({ promise, resolve: resolveFn });
    return promise;
  });

  const vcsGetStatus = vi.fn(() => {
    let resolveFn!: PendingStatusResponse['resolve'];
    const promise = new Promise<{ success: boolean; data?: unknown; error?: { message: string } }>(
      resolve => {
        resolveFn = data => resolve({ success: true, data });
      }
    );
    pendingStatuses.push({ promise, resolve: resolveFn });
    return promise;
  });

  const vcsWatchRepos = vi.fn((repoPaths: string[]) => {
    vcsWatchReposCalls.push([...repoPaths]);
    return Promise.resolve({ success: true, data: { watchedCount: repoPaths.length } });
  });

  function makeWrite(kind: 'stage' | 'unstage') {
    return vi.fn((payload: { workingDirectory: string; filePaths: string[] }) => {
      let resolveFn!: () => void;
      let rejectFn!: (err: unknown) => void;
      const promise = new Promise<{ success: boolean; data?: unknown; error?: { message: string } }>(
        (resolve, reject) => {
          resolveFn = () => resolve({ success: true, data: { exitCode: 0 } });
          rejectFn = err => reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
      pendingWrites.push({ resolve: resolveFn, reject: rejectFn, payload, kind });
      return promise;
    });
  }
  const vcsStageFiles = makeWrite('stage');
  const vcsUnstageFiles = makeWrite('unstage');

  const onVcsStatusChanged = vi.fn(
    (callback: (event: { repoPath: string; reason: string; timestamp: number }) => void) => {
      statusChangedCallback = callback;
      return () => {
        statusChangedCallback = null;
      };
    }
  );

  return {
    mock: {
      vcsFindRepos,
      vcsGetStatus,
      vcsWatchRepos,
      onVcsStatusChanged,
      vcsStageFiles,
      vcsUnstageFiles,
    } as unknown as VcsIpcService,
    pendingFinds,
    pendingStatuses,
    pendingWrites,
    vcsWatchReposCalls,
    fireStatusChanged: (event: { repoPath: string; reason: string; timestamp?: number }) => {
      if (!statusChangedCallback) throw new Error('No status-changed subscription is active');
      statusChangedCallback({ ...event, timestamp: event.timestamp ?? Date.now() });
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('SourceControlStore', () => {
  let store: SourceControlStore;
  let pendingFinds: PendingFindResponse[];
  let pendingStatuses: PendingStatusResponse[];
  let pendingWrites: PendingWriteResponse[];
  let vcsWatchReposCalls: string[][];
  let fireStatusChanged: ReturnType<typeof makeVcsMock>['fireStatusChanged'];

  beforeEach(() => {
    const mockBundle = makeVcsMock();
    pendingFinds = mockBundle.pendingFinds;
    pendingStatuses = mockBundle.pendingStatuses;
    pendingWrites = mockBundle.pendingWrites;
    vcsWatchReposCalls = mockBundle.vcsWatchReposCalls;
    fireStatusChanged = mockBundle.fireStatusChanged;

    TestBed.configureTestingModule({
      providers: [
        SourceControlStore,
        { provide: VcsIpcService, useValue: mockBundle.mock },
      ],
    });

    store = TestBed.inject(SourceControlStore);
    store._resetForTesting();
  });

  // -------------------------------------------------------------------------
  // Basic load behaviour
  // -------------------------------------------------------------------------

  describe('basic load behaviour', () => {
    it('starts empty', () => {
      expect(store.repos()).toEqual([]);
      expect(store.activeRoot()).toBeNull();
      expect(store.totalChangeCount()).toBe(0);
    });

    it('loadForRoot(null) clears state without touching the IPC', () => {
      void store.loadForRoot(null);
      expect(pendingFinds.length).toBe(0);
      expect(store.repos()).toEqual([]);
      expect(store.activeRoot()).toBeNull();
      expect(store.isRefreshing()).toBe(false);
    });

    it('populates repos and statuses for a real root', async () => {
      const promise = store.loadForRoot('/work/a');
      expect(store.activeRoot()).toBe('/work/a');
      expect(store.isRefreshing()).toBe(true);

      pendingFinds[0].resolve({ repositories: ['/work/a/repo1'], gitAvailable: true });
      await Promise.resolve(); // let find resolve and queue statuses
      await Promise.resolve();

      expect(store.repos().length).toBe(1);
      expect(store.repos()[0].absolutePath).toBe('/work/a/repo1');
      expect(store.repos()[0].loading).toBe(true);

      pendingStatuses[0].resolve(status('main', 1, 2, 3));
      await promise;

      expect(store.repos()[0].status?.staged.length).toBe(1);
      expect(store.repos()[0].status?.unstaged.length).toBe(2);
      expect(store.repos()[0].loading).toBe(false);
      expect(store.isRefreshing()).toBe(false);
    });

    it('auto-expands all repos on a new root', async () => {
      const promise = store.loadForRoot('/work/a');
      pendingFinds[0].resolve({
        repositories: ['/work/a/r1', '/work/a/r2'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(store.expandedRepos().has('/work/a/r1')).toBe(true);
      expect(store.expandedRepos().has('/work/a/r2')).toBe(true);

      pendingStatuses[0].resolve(status('main'));
      pendingStatuses[1].resolve(status('main'));
      await promise;
    });

    it('surfaces a non-Git environment as a load error', async () => {
      const promise = store.loadForRoot('/work/a');
      pendingFinds[0].resolve({ repositories: [], gitAvailable: false });
      await promise;

      expect(store.loadError()).toMatch(/Git is not installed/);
      expect(store.repos()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // The critical regression test: stale responses must not overwrite state
  // -------------------------------------------------------------------------

  describe('stale-response protection', () => {
    it('drops a stale vcsFindRepos response after a root switch', async () => {
      // Kick off root A
      const promiseA = store.loadForRoot('/work/A');
      expect(pendingFinds.length).toBe(1);
      // ...don't resolve A yet

      // User switches to root B. Activates immediately.
      const promiseB = store.loadForRoot('/work/B');
      expect(store.activeRoot()).toBe('/work/B');
      expect(pendingFinds.length).toBe(2);

      // Now resolve A's find. It should be dropped — repos must not get
      // A's repo list, and `lastRefreshedRoot` must not flip back to A.
      pendingFinds[0].resolve({
        repositories: ['/work/A/repo-from-A'],
        gitAvailable: true,
      });
      await promiseA;

      expect(store.repos()).toEqual([]); // not yet populated with anything
      expect(store.activeRoot()).toBe('/work/B');

      // Resolve B's find + status. State should reflect B.
      pendingFinds[1].resolve({
        repositories: ['/work/B/repo-from-B'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 3, 0, 0));
      await promiseB;

      expect(store.repos().length).toBe(1);
      expect(store.repos()[0].absolutePath).toBe('/work/B/repo-from-B');
      expect(store.totalChangeCount()).toBe(3);
    });

    it('drops a stale vcsGetStatus response after a root switch', async () => {
      // Root A: find resolves but status is slow.
      const promiseA = store.loadForRoot('/work/A');
      pendingFinds[0].resolve({
        repositories: ['/shared/repo'],  // path shared with root B
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      // pendingStatuses[0] is for A's repo, still unresolved

      // Switch to root B before A's status resolves
      const promiseB = store.loadForRoot('/work/B');
      pendingFinds[1].resolve({
        repositories: ['/shared/repo'],  // intentionally same path
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      // pendingStatuses[1] is for B's repo

      // Resolve A's status with 99 staged changes
      pendingStatuses[0].resolve(status('main', 99));
      await promiseA;

      // Critical: A's stale 99-staged result must NOT have landed on B's
      // state, even though the absolutePath matches.
      expect(store.totalChangeCount()).toBe(0);
      expect(store.repos()[0].status).toBeNull();
      expect(store.repos()[0].loading).toBe(true);

      // Now resolve B's status; that should land cleanly.
      pendingStatuses[1].resolve(status('main', 1));
      await promiseB;
      expect(store.totalChangeCount()).toBe(1);
    });

    it('loadForRoot(null) aborts an in-flight refresh', async () => {
      const promiseA = store.loadForRoot('/work/A');
      // Don't resolve — switch away to null

      await store.loadForRoot(null);

      // Resolve A's find. State must remain cleared.
      pendingFinds[0].resolve({
        repositories: ['/work/A/repo'],
        gitAvailable: true,
      });
      await promiseA;

      expect(store.repos()).toEqual([]);
      expect(store.activeRoot()).toBeNull();
      expect(store.isRefreshing()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Same-root refresh must not wipe existing statuses to loading=true.
  // This is the behaviour Phase 2b's auto-refresh depends on — without it
  // the panel would flicker every cell to "loading…" on every file change.
  // -------------------------------------------------------------------------

  describe('same-root refresh preserves previous status', () => {
    it('keeps the previous status object visible while the refresh is in flight', async () => {
      // Initial load — settles fully
      const initial = store.loadForRoot('/work/project');
      pendingFinds[0].resolve({
        repositories: ['/work/project/repo1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 2, 3));
      await initial;

      expect(store.totalChangeCount()).toBe(5);
      const stableStatusRef = store.repos()[0].status;
      expect(stableStatusRef).not.toBeNull();

      // Manual refresh on the same root — find resolves, but status is
      // not yet resolved. During that window, the previous status must
      // still be visible (i.e. NOT replaced with `null`).
      const second = store.refresh();
      pendingFinds[1].resolve({
        repositories: ['/work/project/repo1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      const midRefresh = store.repos()[0];
      expect(midRefresh.loading).toBe(true);
      expect(midRefresh.status).toBe(stableStatusRef); // identity preserved
      expect(store.totalChangeCount()).toBe(5); // count not zeroed

      // Resolve the new status — should update cleanly.
      pendingStatuses[1].resolve(status('main', 1, 1));
      await second;

      expect(store.repos()[0].loading).toBe(false);
      expect(store.totalChangeCount()).toBe(2);
    });

    it('does NOT preserve status when switching to a different root (paths reset)', async () => {
      // Load root A
      const loadA = store.loadForRoot('/work/A');
      pendingFinds[0].resolve({
        repositories: ['/shared/repo'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 7));
      await loadA;
      expect(store.totalChangeCount()).toBe(7);

      // Switch to root B — even though the repo path is the same, the
      // root changed; treat as a fresh load. The mid-flight state should
      // NOT show A's 7-staged number.
      const loadB = store.loadForRoot('/work/B');
      pendingFinds[1].resolve({
        repositories: ['/shared/repo'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      // status() not yet resolved for B → repo has loading=true and null status.
      expect(store.repos()[0].loading).toBe(true);
      expect(store.repos()[0].status).toBeNull();
      expect(store.totalChangeCount()).toBe(0);

      pendingStatuses[1].resolve(status('main', 0));
      await loadB;
      expect(store.totalChangeCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Aggregate change count (the header pip)
  // -------------------------------------------------------------------------

  describe('totalChangeCount (header pip)', () => {
    it('counts staged + unstaged across all repos', async () => {
      const promise = store.loadForRoot('/work/multi');
      pendingFinds[0].resolve({
        repositories: ['/work/multi/r1', '/work/multi/r2'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      pendingStatuses[0].resolve(status('main', 3, 2, 5));  // r1: 3 staged + 2 unstaged + 5 untracked
      pendingStatuses[1].resolve(status('main', 1, 4, 100)); // r2: 1 staged + 4 unstaged + 100 untracked
      await promise;

      // Excludes untracked per the plan decision (header pip noise).
      // 3 + 2 + 1 + 4 = 10
      expect(store.totalChangeCount()).toBe(10);
    });

    it('returns 0 for clean repos', async () => {
      const promise = store.loadForRoot('/work/clean');
      pendingFinds[0].resolve({
        repositories: ['/work/clean/r1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 0, 0, 0));
      await promise;

      expect(store.totalChangeCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-refresh wiring (Phase 2b)
  // -------------------------------------------------------------------------

  describe('auto-refresh wiring', () => {
    it('pushes the watch set to the main process after a successful find', async () => {
      const promise = store.loadForRoot('/work/multi');
      pendingFinds[0].resolve({
        repositories: ['/work/multi/r1', '/work/multi/r2'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main'));
      pendingStatuses[1].resolve(status('main'));
      await promise;

      // Last vcsWatchRepos call should reflect the discovered repos.
      const lastCall = vcsWatchReposCalls[vcsWatchReposCalls.length - 1];
      expect(lastCall).toEqual(['/work/multi/r1', '/work/multi/r2']);
    });

    it('stops watchers on loadForRoot(null) by pushing []', async () => {
      await store.loadForRoot(null);
      const lastCall = vcsWatchReposCalls[vcsWatchReposCalls.length - 1];
      expect(lastCall).toEqual([]);
    });

    it('refreshOne updates ONE repo without touching the others', async () => {
      // Setup: two repos loaded
      const promise = store.loadForRoot('/work/two');
      pendingFinds[0].resolve({
        repositories: ['/work/two/r1', '/work/two/r2'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 3, 0));
      pendingStatuses[1].resolve(status('main', 5, 0));
      await promise;
      expect(store.totalChangeCount()).toBe(8);

      // refreshOne for r1 — fire then resolve with a different count
      const one = store.refreshOne('/work/two/r1');
      pendingStatuses[2].resolve(status('main', 1, 0));
      await one;

      // r1's count changed to 1; r2 still 5 → total 6
      expect(store.totalChangeCount()).toBe(6);
      expect(store.repos()[0].status?.staged.length).toBe(1);
      expect(store.repos()[1].status?.staged.length).toBe(5);
    });

    it('refreshOne ignores stale results after a root switch', async () => {
      // Setup root A
      const loadA = store.loadForRoot('/work/A');
      pendingFinds[0].resolve({
        repositories: ['/work/A/r1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 1, 0));
      await loadA;

      // Start a refreshOne for r1 — DON'T resolve yet
      const oneInFlight = store.refreshOne('/work/A/r1');

      // Switch to root B (different repo set)
      const loadB = store.loadForRoot('/work/B');
      pendingFinds[1].resolve({
        repositories: ['/work/B/r1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();

      // Now resolve the stale refreshOne with a wildly different status
      pendingStatuses[1].resolve(status('main', 99, 0));
      await oneInFlight;

      // The stale result must NOT have overwritten anything — we're on root B now
      expect(store.activeRoot()).toBe('/work/B');
      // r1 is in B's repos but with no status yet (B's status call is unresolved).
      expect(store.totalChangeCount()).toBe(0);

      // Clean up: resolve B's outstanding status call
      pendingStatuses[2].resolve(status('main'));
      await loadB;
    });

    it('main-process status-changed event triggers refreshOne for that repo', async () => {
      // Setup
      const promise = store.loadForRoot('/work/auto');
      pendingFinds[0].resolve({
        repositories: ['/work/auto/r1'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 0, 0));
      await promise;
      expect(store.totalChangeCount()).toBe(0);

      // Simulate the watcher firing
      fireStatusChanged({ repoPath: '/work/auto/r1', reason: 'worktree' });

      // refreshOne should have kicked off a vcsGetStatus — resolve it
      pendingStatuses[1].resolve(status('main', 2, 1));
      // Yield twice so the refreshOne await chain settles
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(store.totalChangeCount()).toBe(3);
    });

    it('drops status-changed events for repos not currently tracked', async () => {
      // No load yet — fire an event with no repos tracked
      // Just calling loadForRoot(null) installs the subscription.
      await store.loadForRoot(null);

      // This event should be dropped silently — no IPC fired.
      fireStatusChanged({ repoPath: '/some/random/path', reason: 'worktree' });
      await Promise.resolve();
      await Promise.resolve();

      // pendingStatuses should be empty (no refreshOne was triggered).
      expect(pendingStatuses.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Pure mutation helpers
  // -------------------------------------------------------------------------

  describe('toggleRepo / openDiff / closeDiff', () => {
    it('toggleRepo flips expansion state', () => {
      store.toggleRepo('/repo');
      expect(store.isRepoExpanded('/repo')).toBe(true);
      store.toggleRepo('/repo');
      expect(store.isRepoExpanded('/repo')).toBe(false);
    });

    it('openDiff / closeDiff sets and clears the request signal', () => {
      const repo = {
        absolutePath: '/work/r',
        name: 'r',
        relativePath: 'r',
        status: null,
        error: null,
        loading: false,
      };
      store.openDiff(repo, { path: 'a.ts', status: 'modified', staged: false }, false);
      expect(store.diffRequest()?.filePath).toBe('a.ts');
      store.closeDiff();
      expect(store.diffRequest()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Inline file expansion (Phase 2c item 5)
  // -------------------------------------------------------------------------

  describe('toggleFileExpansion', () => {
    it('keys staged and unstaged variants of the same path independently', () => {
      const repo = '/work/r';
      const file = 'src/x.ts';

      expect(store.isFileExpanded(repo, file, true)).toBe(false);
      expect(store.isFileExpanded(repo, file, false)).toBe(false);

      store.toggleFileExpansion(repo, file, true);
      expect(store.isFileExpanded(repo, file, true)).toBe(true);
      // Untouched: the unstaged variant
      expect(store.isFileExpanded(repo, file, false)).toBe(false);

      store.toggleFileExpansion(repo, file, true);
      expect(store.isFileExpanded(repo, file, true)).toBe(false);
    });

    it('expansion survives a same-root refresh (auto-refresh must not collapse rows the user is reading)', async () => {
      // Initial load
      const promise = store.loadForRoot('/work/project');
      pendingFinds[0].resolve({ repositories: ['/work/project/r'], gitAvailable: true });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 1, 0));
      await promise;

      store.toggleFileExpansion('/work/project/r', 'staged-0.ts', true);
      expect(store.isFileExpanded('/work/project/r', 'staged-0.ts', true)).toBe(true);

      // Auto-refresh on the same root via a status-changed event
      fireStatusChanged({ repoPath: '/work/project/r', reason: 'index' });
      pendingStatuses[1].resolve(status('main', 1, 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Expansion must NOT have been cleared.
      expect(store.isFileExpanded('/work/project/r', 'staged-0.ts', true)).toBe(true);
    });

    it('expansion is cleared when switching to a new root', async () => {
      // Set up root A with one expanded row
      const loadA = store.loadForRoot('/work/A');
      pendingFinds[0].resolve({ repositories: ['/work/A/r'], gitAvailable: true });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 0, 0));
      await loadA;

      store.toggleFileExpansion('/work/A/r', 'foo.ts', true);
      expect(store.expandedFiles().size).toBe(1);

      // Switch to root B
      const loadB = store.loadForRoot('/work/B');
      pendingFinds[1].resolve({ repositories: ['/work/B/r'], gitAvailable: true });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[1].resolve(status('main', 0, 0));
      await loadB;

      // Expansions from root A must be gone.
      expect(store.expandedFiles().size).toBe(0);
    });

    it('expansion is cleared on loadForRoot(null)', async () => {
      const loadA = store.loadForRoot('/work/A');
      pendingFinds[0].resolve({ repositories: ['/work/A/r'], gitAvailable: true });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 0, 0));
      await loadA;
      store.toggleFileExpansion('/work/A/r', 'foo.ts', true);

      await store.loadForRoot(null);
      expect(store.expandedFiles().size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2d — stage / unstage write actions + write-token coalescing
  // -------------------------------------------------------------------------

  describe('Phase 2d — stageFiles / unstageFiles', () => {
    /** Spin up the store loaded against `/work/p` with one repo `/work/p/r`. */
    async function loadOneRepo() {
      const loadP = store.loadForRoot('/work/p');
      pendingFinds[0].resolve({
        repositories: ['/work/p/r'],
        gitAvailable: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      pendingStatuses[0].resolve(status('main', 0, 1));
      await loadP;
    }

    it('stageFiles invokes the IPC service with workingDirectory + filePaths', async () => {
      await loadOneRepo();

      const op = store.stageFiles('/work/p/r', ['a.ts', 'b.ts']);
      // Capture the write call before resolving so the assertion runs
      // against the in-flight call shape.
      expect(pendingWrites.length).toBe(1);
      expect(pendingWrites[0].kind).toBe('stage');
      expect(pendingWrites[0].payload).toEqual({
        workingDirectory: '/work/p/r',
        filePaths: ['a.ts', 'b.ts'],
      });

      pendingWrites[0].resolve();
      const result = await op;
      expect(result.success).toBe(true);
    });

    it('unstageFiles invokes the IPC service with workingDirectory + filePaths', async () => {
      await loadOneRepo();

      const op = store.unstageFiles('/work/p/r', ['a.ts']);
      expect(pendingWrites.length).toBe(1);
      expect(pendingWrites[0].kind).toBe('unstage');
      pendingWrites[0].resolve();
      const result = await op;
      expect(result.success).toBe(true);
    });

    it('surfaces a structured failure via loadError when the write fails', async () => {
      await loadOneRepo();
      expect(store.loadError()).toBeNull();

      const op = store.stageFiles('/work/p/r', ['a.ts']);
      // Simulate an IPC failure by overriding the pendingWrite resolver
      // to return the failed envelope. Easiest path: reject the
      // promise — the store catches in runWrite.
      pendingWrites[0].reject(new Error('git add: fatal'));
      const result = await op;

      expect(result.success).toBe(false);
      expect(result.error).toBe('git add: fatal');
      expect(store.loadError()).toBe('git add: fatal');
    });

    it('marks the repo as writing while the IPC call is in flight', async () => {
      await loadOneRepo();
      expect(store.isWriting('/work/p/r')).toBe(false);

      const op = store.stageFiles('/work/p/r', ['a.ts']);
      // Yield so the runWrite acquires its token before we assert.
      await Promise.resolve();
      expect(store.isWriting('/work/p/r')).toBe(true);

      pendingWrites[0].resolve();
      await op;
      expect(store.isWriting('/work/p/r')).toBe(false);
    });

    it('coalesces watcher events that arrive while a write is in flight', async () => {
      await loadOneRepo();

      const op = store.stageFiles('/work/p/r', ['a.ts']);
      await Promise.resolve();
      expect(store.isWriting('/work/p/r')).toBe(true);

      // The watcher fires while the write is in-flight. The store
      // should buffer this — not trigger a refreshOne now.
      const statusesBefore = pendingStatuses.length;
      fireStatusChanged({ repoPath: '/work/p/r', reason: 'index' });
      // Allow microtasks to drain
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingStatuses.length).toBe(statusesBefore); // no new refreshOne fired

      pendingWrites[0].resolve();
      await op;
    });

    it('endWrite triggers a refreshOne for the affected repo after grace period', async () => {
      vi.useFakeTimers();
      try {
        await loadOneRepo();

        const op = store.stageFiles('/work/p/r', ['a.ts']);
        await Promise.resolve();
        pendingWrites[0].resolve();
        await op;

        // After the write resolves but before the grace timer fires,
        // no refreshOne has been triggered yet.
        const statusesBefore = pendingStatuses.length;

        // Advance time past the grace window. The store uses 300ms by
        // default; advance well past that.
        await vi.advanceTimersByTimeAsync(400);

        // refreshOne should have fired (one new vcsGetStatus call).
        expect(pendingStatuses.length).toBe(statusesBefore + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('endWrite is idempotent — releasing the same token twice is a no-op', () => {
      const token = store.beginWrite('/work/p/r', 'stage');
      expect(store.isWriting('/work/p/r')).toBe(true);

      store.endWrite('/work/p/r', token);
      expect(store.isWriting('/work/p/r')).toBe(false);

      // Releasing again must not throw or flip state in any direction.
      store.endWrite('/work/p/r', token);
      expect(store.isWriting('/work/p/r')).toBe(false);
    });

    it('multiple concurrent writes on the same repo: signal stays writing until last endWrite', () => {
      const t1 = store.beginWrite('/work/p/r', 'stage');
      const t2 = store.beginWrite('/work/p/r', 'stage');

      expect(store.isWriting('/work/p/r')).toBe(true);
      store.endWrite('/work/p/r', t1);
      expect(store.isWriting('/work/p/r')).toBe(true); // t2 still active
      store.endWrite('/work/p/r', t2);
      expect(store.isWriting('/work/p/r')).toBe(false);
    });

    it('writes on different repos do not interfere', () => {
      const tA = store.beginWrite('/work/A', 'stage');
      const tB = store.beginWrite('/work/B', 'unstage');
      expect(store.isWriting('/work/A')).toBe(true);
      expect(store.isWriting('/work/B')).toBe(true);

      store.endWrite('/work/A', tA);
      expect(store.isWriting('/work/A')).toBe(false);
      expect(store.isWriting('/work/B')).toBe(true);

      store.endWrite('/work/B', tB);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe('relativeFromRoot', () => {
  it('returns "." when paths are equal', () => {
    expect(relativeFromRoot('/work/a', '/work/a')).toBe('.');
  });

  it('strips the root prefix when nested', () => {
    expect(relativeFromRoot('/work/a', '/work/a/repo1')).toBe('repo1');
    expect(relativeFromRoot('/work/a', '/work/a/nested/repo')).toBe('nested/repo');
  });

  it('returns the full path when not nested', () => {
    expect(relativeFromRoot('/work/a', '/elsewhere/repo')).toBe('/elsewhere/repo');
  });
});
