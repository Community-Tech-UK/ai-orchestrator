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
 *      module and a mock native worktree watcher so we can drive events
 *      synchronously and assert on the emitted `status-changed` events.
 *
 * No real filesystem, no real chokidar, no real git.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as path from 'path';

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
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
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
// Mock the native worktree watcher so we don't spin up real fs watches for
// the working-tree surface.
// ---------------------------------------------------------------------------

class MockWorkTreeWatcher {
  close = vi.fn().mockResolvedValue(undefined);

  constructor(
    readonly repoPath: string,
    private readonly onChange: (changedPath: string) => void,
  ) {}

  fireChange(changedPath = path.join(this.repoPath, 'src', 'file.ts')): void {
    this.onChange(changedPath);
  }
}

const createdWorkTreeWatchers: MockWorkTreeWatcher[] = [];

function workPath(...segments: string[]): string {
  return path.resolve(path.join(path.sep, 'work', ...segments));
}

function createMockWorkTreeWatcher(
  repoPath: string,
  onChange: (changedPath: string) => void,
): MockWorkTreeWatcher {
  const watcher = new MockWorkTreeWatcher(repoPath, onChange);
  createdWorkTreeWatchers.push(watcher);
  return watcher;
}

// ---------------------------------------------------------------------------
// Now import the system under test.
// ---------------------------------------------------------------------------

import {
  GitStatusWatcher,
  WorkerBackedGitStatusWatcher,
  resolveGitDirs,
  type GitStatusChangedEvent,
} from './git-status-watcher';
import type {
  GitStatusWatcherWorkerInboundMsg,
  GitStatusWatcherWorkerOutboundMsg,
} from './git-status-watcher-protocol';

beforeEach(() => {
  createdWatchers.length = 0;
  createdWorkTreeWatchers.length = 0;
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

    const repoPath = workPath('normal-repo');
    const result = await resolveGitDirs(repoPath, fakeExec as never);
    expect(result).toEqual({
      gitDir: path.join(repoPath, '.git'),
      commonDir: path.join(repoPath, '.git'),
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
          return { stdout: path.join(workPath('main'), '.git', 'worktrees', 'feature') + '\n' };
        }
        if (which === '--git-common-dir') {
          return { stdout: path.join(workPath('main'), '.git') + '\n' };
        }
        throw new Error('unexpected args');
      },
    );

    const result = await resolveGitDirs(workPath('worktree-feature'), fakeExec as never);
    expect(result).not.toBeNull();
    expect(result!.gitDir).toBe(path.join(workPath('main'), '.git', 'worktrees', 'feature'));
    expect(result!.commonDir).toBe(path.join(workPath('main'), '.git'));
    expect(result!.gitDir).not.toBe(result!.commonDir);
  });

  it('returns null when git fails (e.g. path is not a repo)', async () => {
    const fakeExec = vi.fn().mockRejectedValue(new Error('not a git repository'));
    const result = await resolveGitDirs(path.join(path.sep, 'tmp', 'not-a-repo'), fakeExec as never);
    expect(result).toBeNull();
  });

  // Phase 2 plan: "git rev-parse --git-dir and --git-common-dir can
  // return relative paths. Resolve each non-absolute output against the
  // repo working directory before handing it to chokidar."
  it('resolves relative gitdir/common-dir outputs against the repo cwd', async () => {
    const fakeExec = vi.fn().mockImplementation(
      async (_cmd: string, args: string[]) => {
        const which = args[1];
        // Plain `.git` (relative) is the most common case for a non-
        // worktree repo. Even with the linked-worktree shape git can
        // emit relative paths depending on how the repo was created.
        if (which === '--git-dir') return { stdout: '.git\n' };
        if (which === '--git-common-dir') return { stdout: '.git\n' };
        throw new Error('unexpected args');
      },
    );
    const repoPath = workPath('sub', 'repo');
    const result = await resolveGitDirs(repoPath, fakeExec as never);
    expect(result).not.toBeNull();
    // Both must be absolute paths anchored at the repo cwd.
    expect(result!.gitDir).toBe(path.join(repoPath, '.git'));
    expect(result!.commonDir).toBe(path.join(repoPath, '.git'));
  });
});

// ---------------------------------------------------------------------------
// GitStatusWatcher.setRepos lifecycle + event surfaces
// ---------------------------------------------------------------------------

describe('GitStatusWatcher', () => {
  let watcher: GitStatusWatcher;
  let events: GitStatusChangedEvent[];

  function setupWatcher(opts: { debounceMs?: number } = {}) {
    watcher = new GitStatusWatcher({
      // Default to 0ms so we don't need fake timers in basic tests.
      debounceMs: opts.debounceMs ?? 0,
      createWorkTreeWatcher: createMockWorkTreeWatcher,
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
    // The native worktree watcher was created for the working tree.
    expect(createdWorkTreeWatchers.length).toBe(1);
    expect(createdWorkTreeWatchers[0].repoPath).toBe(repoPath);
    // Two chokidar watchers were created (gitdir + commonDir).
    expect(createdWatchers.length).toBe(2);

    await watcher.setRepos([]);
    expect(watcher.watchedRepos()).toEqual([]);
    expect(createdWorkTreeWatchers[0].close).toHaveBeenCalledOnce();
    expect(createdWatchers.every(w => w.close.mock.calls.length > 0)).toBe(true);
  });

  it('preserves existing watches when setRepos overlaps', async () => {
    setupWatcher();
    const repoA = process.cwd();

    // Initial: just A
    await watcher.setRepos([repoA]);
    const watchersAfterA = createdWatchers.length;
    const worktreeWatchersAfterA = createdWorkTreeWatchers.length;

    // Setting the same set again should NOT churn watchers
    await watcher.setRepos([repoA]);
    expect(createdWatchers.length).toBe(watchersAfterA);
    expect(createdWorkTreeWatchers.length).toBe(worktreeWatchersAfterA);
    expect(watcher.watchedRepos()).toEqual([repoA]);
  });

  it('emits status-changed with reason="worktree" when the native worktree watcher fires', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    createdWorkTreeWatchers[0].fireChange();
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
    const indexPath = gitDirWatcher.watchedPaths.find(p => path.basename(p) === 'index');
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
      p => path.basename(p) === 'HEAD' && !p.split(path.sep).includes('logs'),
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

    // Fire 5 events in rapid succession
    for (let i = 0; i < 5; i++) createdWorkTreeWatchers[0].fireChange();

    // No emission yet
    expect(events.filter(e => e.reason === 'worktree').length).toBe(0);

    // Advance past the debounce window
    vi.advanceTimersByTime(60);
    expect(events.filter(e => e.reason === 'worktree').length).toBe(1);
  });

  it('stop() drains the setReposChain so no watchers leak past teardown', async () => {
    let resolveCount = 0;
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      createWorkTreeWatcher: createMockWorkTreeWatcher,
      resolveGitDirs: async (repoPath) => {
        resolveCount++;
        // Yield so stop() can be called mid-setRepos.
        await new Promise(r => setTimeout(r, 10));
        return { gitDir: path.join(repoPath, '.git'), commonDir: path.join(repoPath, '.git') };
      },
    });

    // Fire a setRepos and stop() back-to-back; both must settle without
    // leaving the watcher in a half-state.
    const repoA = workPath('A');
    const repoB = workPath('B');
    const inflight = watcher.setRepos([repoA, repoB]);
    await watcher.stop();
    await inflight;

    // After stop+setRepos drain: no repos watched, no native worktree
    // watchers held, no chokidar watchers still alive.
    expect(watcher.watchedRepos()).toEqual([]);
    // All worktree watchers opened during the in-flight setRepos should
    // have been closed as part of the cleanup.
    expect(createdWorkTreeWatchers.every(w => w.close.mock.calls.length > 0)).toBe(true);
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
    let resolveCount = 0;
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      createWorkTreeWatcher: createMockWorkTreeWatcher,
      resolveGitDirs: async (repoPath) => {
        resolveCount++;
        // Yield to let the second setRepos enter doSetRepos before
        // this one resolves — exercises the race.
        await new Promise(r => setTimeout(r, 10));
        return { gitDir: path.join(repoPath, '.git'), commonDir: path.join(repoPath, '.git') };
      },
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));

    // Fire two calls without awaiting the first.
    const repoA = workPath('A');
    const repoB = workPath('B');
    const repoC = workPath('C');
    const firstCall = watcher.setRepos([repoA, repoB]);
    const secondCall = watcher.setRepos([repoC]);

    await Promise.all([firstCall, secondCall]);

    // Final state: only C watched. A and B's watchers must be cleaned up
    // (or never created, depending on timing) — but A and B must NOT
    // appear in `watchedRepos()`.
    expect(watcher.watchedRepos()).toEqual([repoC]);
    expect(resolveCount).toBeGreaterThanOrEqual(1);
  });

  it('watches the LINKED worktree gitdir, not <repo>/.git (regression for the plan-flagged bug)', async () => {
    // Simulate a linked worktree: the resolver returns paths under
    // the main repo's .git/worktrees/<name>, NOT under the worktree
    // path itself. A naive `<repoPath>/.git/index` watcher would
    // silently never fire for this layout.
    const mainGitDir = path.join(workPath('main'), '.git');
    const worktreePath = workPath('worktree-feature');
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      createWorkTreeWatcher: createMockWorkTreeWatcher,
      resolveGitDirs: async () => ({
        gitDir: path.join(mainGitDir, 'worktrees', 'feature'),
        commonDir: mainGitDir,
      }),
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));

    await watcher.setRepos([worktreePath]);

    // The chokidar gitdir watcher (first created) should target the
    // worktree's actual gitdir, not /work/worktree-feature/.git/...
    const gitDirWatcher = createdWatchers[0];
    expect(gitDirWatcher.watchedPaths).toContain(path.join(mainGitDir, 'worktrees', 'feature', 'index'));
    expect(gitDirWatcher.watchedPaths).toContain(path.join(mainGitDir, 'worktrees', 'feature', 'HEAD'));
    // None of the watched paths should fall under the worktree's own .git
    expect(gitDirWatcher.watchedPaths.some(p =>
      p.startsWith(path.join(worktreePath, '.git') + path.sep),
    )).toBe(false);

    // The common-dir watcher (second) should target the SHARED .git
    const commonDirWatcher = createdWatchers[1];
    expect(commonDirWatcher.watchedPaths).toContain(path.join(mainGitDir, 'refs'));
    expect(commonDirWatcher.watchedPaths).toContain(path.join(mainGitDir, 'packed-refs'));
  });

  it('routes native worktree events to the correct repo', async () => {
    watcher = new GitStatusWatcher({
      debounceMs: 0,
      createWorkTreeWatcher: createMockWorkTreeWatcher,
      resolveGitDirs: async (repoPath) => ({
        gitDir: path.join(repoPath, '.git'),
        commonDir: path.join(repoPath, '.git'),
      }),
    });
    events = [];
    watcher.on('status-changed', e => events.push(e));

    const repoA = workPath('A');
    const repoB = workPath('B');
    await watcher.setRepos([repoA, repoB]);

    const repoAWatcher = createdWorkTreeWatchers.find(w => w.repoPath === repoA);
    const repoBWatcher = createdWorkTreeWatchers.find(w => w.repoPath === repoB);
    expect(repoAWatcher).toBeDefined();
    expect(repoBWatcher).toBeDefined();

    repoBWatcher!.fireChange(path.join(repoB, 'src', 'file.ts'));
    await new Promise(r => setTimeout(r, 5));

    expect(events.filter(e => e.reason === 'worktree' && e.repoPath === repoB).length).toBe(1);
    expect(events.filter(e => e.repoPath === repoA).length).toBe(0);
  });

  it('ignores pruned generated/dependency paths from worktree events', async () => {
    setupWatcher();
    const repoPath = process.cwd();
    await watcher.setRepos([repoPath]);

    createdWorkTreeWatchers[0].fireChange(path.join(repoPath, 'node_modules', 'pkg', 'index.js'));
    createdWorkTreeWatchers[0].fireChange(path.join(repoPath, 'release', 'mac-arm64', 'app'));
    await new Promise(r => setTimeout(r, 5));

    expect(events.filter(e => e.reason === 'worktree').length).toBe(0);
  });
});

describe('WorkerBackedGitStatusWatcher', () => {
  class FakeWorker extends EventEmitter {
    readonly messages: GitStatusWatcherWorkerInboundMsg[] = [];
    readonly postMessage = vi.fn((message: GitStatusWatcherWorkerInboundMsg) => {
      this.messages.push(message);
    });
    readonly terminate = vi.fn(async () => 0);

    reply(message: GitStatusWatcherWorkerOutboundMsg): void {
      this.emit('message', message);
    }
  }

  function setupWorkerBackedWatcher(opts: { rpcTimeoutMs?: number } = {}) {
    const workers: FakeWorker[] = [];
    const watcher = new WorkerBackedGitStatusWatcher({
      rpcTimeoutMs: opts.rpcTimeoutMs ?? 50,
      registerCleanup: vi.fn(),
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as never;
      },
    });
    return { watcher, workers };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates watched repos from worker responses', async () => {
    const { watcher, workers } = setupWorkerBackedWatcher();

    const pending = watcher.setRepos([workPath('A')]);
    const message = workers[0].messages[0];
    expect(message).toMatchObject({ type: 'set-repos', repoPaths: [workPath('A')] });
    workers[0].reply({
      type: 'response',
      id: message.id,
      ok: true,
      watchedRepos: [workPath('A')],
    });
    await pending;

    expect(watcher.watchedRepos()).toEqual([workPath('A')]);
    await watcher.stop();
  });

  it('relays status-changed events from the worker', async () => {
    const { watcher, workers } = setupWorkerBackedWatcher();
    const events: GitStatusChangedEvent[] = [];
    watcher.on('status-changed', event => events.push(event));

    const pending = watcher.setRepos([workPath('A')]);
    const message = workers[0].messages[0];
    workers[0].reply({
      type: 'response',
      id: message.id,
      ok: true,
      watchedRepos: [workPath('A')],
    });
    await pending;

    const event: GitStatusChangedEvent = {
      repoPath: workPath('A'),
      reason: 'worktree',
      timestamp: Date.now(),
    };
    workers[0].reply({ type: 'status-changed', event });

    expect(events).toEqual([event]);
    await watcher.stop();
  });

  it('terminates a stuck worker on setRepos timeout', async () => {
    const { watcher, workers } = setupWorkerBackedWatcher({ rpcTimeoutMs: 5 });

    await watcher.setRepos([]);

    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(watcher.watchedRepos()).toEqual([]);
    await watcher.stop();
  });
});
