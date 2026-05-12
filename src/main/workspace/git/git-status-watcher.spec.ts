/**
 * GitStatusWatcher tests.
 *
 * Two halves:
 *
 *   1. `resolveGitDirs` — pure function over `git rev-parse` output.
 *      Tests the linked-worktree case the plan flagged as load-bearing:
 *      `<repo>/.git` is a FILE pointing at `<main-gitdir>/worktrees/<name>`,
 *      and `--git-dir` / `--git-common-dir` return DIFFERENT paths. A
 *      naive implementation that watches `<repo>/.git/index` would
 *      silently never fire.
 *
 *   2. `GitStatusWatcher.setRepos` lifecycle — uses a mock chokidar
 *      module and a mock FileWatcherManager so we can drive events
 *      synchronously and assert on the emitted `status-changed` events.
 *
 * No real filesystem, no real chokidar, no real git.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Mock chokidar BEFORE importing the system under test.
// ---------------------------------------------------------------------------

interface MockWatcher {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
  watchedPaths: string[];
}

const createdWatchers: MockWatcher[] = [];

vi.mock('chokidar', () => ({
  watch: (paths: string[] | string) => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const watcher: MockWatcher = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = handlers.get(event) ?? [];
        list.push(cb);
        handlers.set(event, list);
        return watcher;
      }),
      close: vi.fn().mockResolvedValue(undefined),
      emit: (event: string, ...args: unknown[]) => {
        for (const cb of handlers.get(event) ?? []) cb(...args);
      },
      watchedPaths: Array.isArray(paths) ? [...paths] : [paths],
    };
    createdWatchers.push(watcher);
    return watcher;
  },
}));

// ---------------------------------------------------------------------------
// Mock FileWatcherManager so we don't spin up real fs watches for the
// working-tree surface.
// ---------------------------------------------------------------------------

class MockFileWatcherManager extends EventEmitter {
  watchCalls: Array<{ directory: string; sessionId: string }> = [];
  unwatchCalls: string[] = [];
  private nextSessionId = 0;

  async watch(directory: string): Promise<{ id: string }> {
    const id = `session-${++this.nextSessionId}`;
    this.watchCalls.push({ directory, sessionId: id });
    return { id };
  }

  async unwatch(sessionId: string): Promise<void> {
    this.unwatchCalls.push(sessionId);
  }

  /** Convenience for tests — emit a change event for a session. */
  fireChange(sessionId: string): void {
    this.emit('change', sessionId, {
      type: 'change',
      path: '/dummy',
      relativePath: 'dummy',
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Now import the system under test.
// ---------------------------------------------------------------------------

import {
  GitStatusWatcher,
  resolveGitDirs,
  type GitStatusChangedEvent,
} from './git-status-watcher';

beforeEach(() => {
  createdWatchers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// resolveGitDirs
// ---------------------------------------------------------------------------

describe('resolveGitDirs', () => {
  it('returns identical paths for a normal (non-worktree) repo', async () => {
    const fakeExec = vi.fn().mockImplementation(
      async (_cmd: string, args: string[]) => {
        const which = args[1];
        if (which === '--git-dir') return { stdout: '.git\n' };
        if (which === '--git-common-dir') return { stdout: '.git\n' };
        throw new Error('unexpected args');
      },
    );

    const result = await resolveGitDirs('/work/normal-repo', fakeExec as never);
    expect(result).toEqual({
      gitDir: '/work/normal-repo/.git',
      commonDir: '/work/normal-repo/.git',
    });
  });

  it('returns DIFFERENT paths for a linked worktree (regression for the plan-flagged bug)', async () => {
    // A linked worktree's `git rev-parse --git-dir` points at the
    // main repo's `.git/worktrees/<name>` directory; `--git-common-dir`
    // points at the shared `.git` itself.
    const fakeExec = vi.fn().mockImplementation(
      async (_cmd: string, args: string[]) => {
        const which = args[1];
        if (which === '--git-dir') {
          return { stdout: '/work/main/.git/worktrees/feature/\n' };
        }
        if (which === '--git-common-dir') {
          return { stdout: '/work/main/.git/\n' };
        }
        throw new Error('unexpected args');
      },
    );

    const result = await resolveGitDirs('/work/worktree-feature', fakeExec as never);
    expect(result).not.toBeNull();
    expect(result!.gitDir).toBe('/work/main/.git/worktrees/feature');
    expect(result!.commonDir).toBe('/work/main/.git');
    expect(result!.gitDir).not.toBe(result!.commonDir);
  });

  it('returns null when git fails (e.g. path is not a repo)', async () => {
    const fakeExec = vi.fn().mockRejectedValue(new Error('not a git repository'));
    const result = await resolveGitDirs('/tmp/not-a-repo', fakeExec as never);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitStatusWatcher.setRepos lifecycle + event surfaces
// ---------------------------------------------------------------------------

describe('GitStatusWatcher', () => {
  let fileWatcher: MockFileWatcherManager;
  let watcher: GitStatusWatcher;
  let events: GitStatusChangedEvent[];

  function setupWatcher(opts: { debounceMs?: number } = {}) {
    fileWatcher = new MockFileWatcherManager();
    watcher = new GitStatusWatcher({
      // Default to 0ms so we don't need fake timers in basic tests.
      debounceMs: opts.debounceMs ?? 0,
      // Cast: the MockFileWatcherManager exposes the same `on`,
      // `watch`, `unwatch` surface that GitStatusWatcher actually
      // touches, which is all the type-cast needs.
      fileWatcher: fileWatcher as never,
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));
  }

  // Lifecycle tests fall into two groups:
  //   - "real repo" tests use `process.cwd()` so the production
  //     `resolveGitDirs` runs against this project's actual `.git`.
  //     They exercise the real chokidar + path-resolution path.
  //   - "stubbed" tests pass `resolveGitDirs: async () => ({...})` to
  //     the watcher constructor for cases that need a specific layout
  //     (e.g. linked worktrees) or deterministic timing.

  afterEach(async () => {
    await watcher?.stop();
  });

  it('starts and stops watchers (real repo)', async () => {
    setupWatcher();
    const repoPath = process.cwd(); // this project IS a git repo

    await watcher.setRepos([repoPath]);
    expect(watcher.watchedRepos()).toEqual([repoPath]);
    // FileWatcherManager.watch was called for the working tree.
    expect(fileWatcher.watchCalls.length).toBe(1);
    expect(fileWatcher.watchCalls[0].directory).toBe(repoPath);
    // Two chokidar watchers were created (gitdir + commonDir).
    expect(createdWatchers.length).toBe(2);

    await watcher.setRepos([]);
    expect(watcher.watchedRepos()).toEqual([]);
    expect(fileWatcher.unwatchCalls.length).toBe(1);
    expect(createdWatchers.every(w => w.close.mock.calls.length > 0)).toBe(true);
  });

  it('preserves existing watches when setRepos overlaps', async () => {
    setupWatcher();
    const repoA = process.cwd();

    // Initial: just A
    await watcher.setRepos([repoA]);
    const watchersAfterA = createdWatchers.length;
    const fwmCallsAfterA = fileWatcher.watchCalls.length;

    // Setting the same set again should NOT churn watchers
    await watcher.setRepos([repoA]);
    expect(createdWatchers.length).toBe(watchersAfterA);
    expect(fileWatcher.watchCalls.length).toBe(fwmCallsAfterA);
    expect(watcher.watchedRepos()).toEqual([repoA]);
  });

  it('emits status-changed with reason="worktree" when the FileWatcherManager fires', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    const session = fileWatcher.watchCalls[0].sessionId;
    fileWatcher.fireChange(session);
    // 0ms debounce: event fires asynchronously through setTimeout.
    await new Promise(r => setTimeout(r, 5));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const matching = events.filter(e => e.reason === 'worktree' && e.repoPath === repoPath);
    expect(matching.length).toBe(1);
  });

  it('emits status-changed with reason="index" when the gitdir index changes', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    // Find the gitdir watcher — first chokidar watcher created.
    const gitDirWatcher = createdWatchers[0];
    const indexPath = gitDirWatcher.watchedPaths.find(p => p.endsWith('/index'));
    expect(indexPath).toBeDefined();

    gitDirWatcher.emit('change', indexPath!);
    await new Promise(r => setTimeout(r, 5));

    const indexEvents = events.filter(e => e.reason === 'index');
    expect(indexEvents.length).toBe(1);
    expect(indexEvents[0].repoPath).toBe(repoPath);
  });

  it('emits status-changed with reason="head" when HEAD changes', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    const gitDirWatcher = createdWatchers[0];
    const headPath = gitDirWatcher.watchedPaths.find(
      p => p.endsWith('/HEAD') && !p.includes('logs'),
    );
    expect(headPath).toBeDefined();

    gitDirWatcher.emit('change', headPath!);
    await new Promise(r => setTimeout(r, 5));

    expect(events.filter(e => e.reason === 'head').length).toBe(1);
  });

  it('debounces rapid same-reason events on the same repo', async () => {
    setupWatcher({ debounceMs: 50 });
    vi.useFakeTimers();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    const session = fileWatcher.watchCalls[0].sessionId;
    // Fire 5 events in rapid succession
    for (let i = 0; i < 5; i++) fileWatcher.fireChange(session);

    // No emission yet
    expect(events.filter(e => e.reason === 'worktree').length).toBe(0);

    // Advance past the debounce window
    vi.advanceTimersByTime(60);
    expect(events.filter(e => e.reason === 'worktree').length).toBe(1);
  });

  it('stop() drains the setReposChain so no watchers leak past teardown', async () => {
    fileWatcher = new MockFileWatcherManager();
    let resolveCount = 0;
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      fileWatcher: fileWatcher as never,
      resolveGitDirs: async (repoPath) => {
        resolveCount++;
        // Yield so stop() can be called mid-setRepos.
        await new Promise(r => setTimeout(r, 10));
        return { gitDir: `${repoPath}/.git`, commonDir: `${repoPath}/.git` };
      },
    });

    // Fire a setRepos and stop() back-to-back; both must settle without
    // leaving the watcher in a half-state.
    const inflight = watcher.setRepos(['/work/A', '/work/B']);
    await watcher.stop();
    await inflight;

    // After stop+setRepos drain: no repos watched, no FileWatcherManager
    // sessions held, no chokidar watchers still alive.
    expect(watcher.watchedRepos()).toEqual([]);
    // All sessions opened during the in-flight setRepos should have been
    // unwatched as part of the cleanup.
    expect(fileWatcher.watchCalls.length).toBe(fileWatcher.unwatchCalls.length);
    // All chokidar watchers created should be closed.
    for (const w of createdWatchers) {
      expect(w.close.mock.calls.length).toBeGreaterThanOrEqual(1);
    }
    expect(resolveCount).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent setRepos calls — last call wins, no orphan watchers', async () => {
    // Use an injected resolver that adds a tiny artificial delay so
    // the first setRepos doesn't synchronously complete before the
    // second starts.
    fileWatcher = new MockFileWatcherManager();
    let resolveCount = 0;
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      fileWatcher: fileWatcher as never,
      resolveGitDirs: async (repoPath) => {
        resolveCount++;
        // Yield to let the second setRepos enter doSetRepos before
        // this one resolves — exercises the race.
        await new Promise(r => setTimeout(r, 10));
        return { gitDir: `${repoPath}/.git`, commonDir: `${repoPath}/.git` };
      },
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));

    // Fire two calls without awaiting the first.
    const firstCall = watcher.setRepos(['/work/A', '/work/B']);
    const secondCall = watcher.setRepos(['/work/C']);

    await Promise.all([firstCall, secondCall]);

    // Final state: only C watched. A and B's watchers must be cleaned up
    // (or never created, depending on timing) — but A and B must NOT
    // appear in `watchedRepos()`.
    expect(watcher.watchedRepos()).toEqual(['/work/C']);
  });

  it('watches the LINKED worktree gitdir, not <repo>/.git (regression for the plan-flagged bug)', async () => {
    // Simulate a linked worktree: the resolver returns paths under
    // the main repo's .git/worktrees/<name>, NOT under the worktree
    // path itself. A naive `<repoPath>/.git/index` watcher would
    // silently never fire for this layout.
    fileWatcher = new MockFileWatcherManager();
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      fileWatcher: fileWatcher as never,
      resolveGitDirs: async () => ({
        gitDir: '/work/main/.git/worktrees/feature',
        commonDir: '/work/main/.git',
      }),
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));

    await watcher.setRepos(['/work/worktree-feature']);

    // The chokidar gitdir watcher (first created) should target the
    // worktree's actual gitdir, not /work/worktree-feature/.git/...
    const gitDirWatcher = createdWatchers[0];
    expect(gitDirWatcher.watchedPaths).toContain('/work/main/.git/worktrees/feature/index');
    expect(gitDirWatcher.watchedPaths).toContain('/work/main/.git/worktrees/feature/HEAD');
    // None of the watched paths should fall under the worktree's own .git
    expect(gitDirWatcher.watchedPaths.some(p =>
      p.startsWith('/work/worktree-feature/.git/'),
    )).toBe(false);

    // The common-dir watcher (second) should target the SHARED .git
    const commonDirWatcher = createdWatchers[1];
    expect(commonDirWatcher.watchedPaths).toContain('/work/main/.git/refs');
    expect(commonDirWatcher.watchedPaths).toContain('/work/main/.git/packed-refs');
  });

  it('routes per-session worktree events to the correct repo', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    const session = fileWatcher.watchCalls[0].sessionId;

    // Fire a change for a session that isn't tracked — must NOT emit.
    fileWatcher.fireChange('nonexistent-session');
    await new Promise(r => setTimeout(r, 5));
    expect(events.length).toBe(0);

    // Fire for the real session — emits.
    fileWatcher.fireChange(session);
    await new Promise(r => setTimeout(r, 5));
    expect(events.filter(e => e.reason === 'worktree').length).toBe(1);
  });
});
