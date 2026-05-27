/**
 * Unit tests for `CodememPrewarmCoordinator`.
 *
 * Strategy:
 *   - Inject a plain `EventEmitter` in place of the real
 *     `RecentDirectoriesManager` so we don't pull in `electron-store`.
 *   - Inject a `PrewarmCodememTarget` mock with deferred `warmWorkspace`
 *     promises so we can deterministically observe queue ordering and the
 *     concurrency cap without timing flakes.
 *   - Inject a `PrewarmSettingsTarget` whose `get(key)` returns canned values
 *     per test.
 *   - Use real temp directories so the coordinator's `fs.statSync` belt &
 *     braces check passes.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodememPrewarmCoordinator,
  type CodememPrewarmCoordinatorOptions,
  type PrewarmCodememTarget,
  type PrewarmSettingsTarget,
} from '../codemem-prewarm-coordinator';
import type { AppSettings } from '../../../shared/types/settings.types';
import type { RecentDirectoryEntry } from '../../../shared/types/recent-directories.types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function createSettings(overrides: Partial<AppSettings> = {}): PrewarmSettingsTarget {
  const defaults: Partial<AppSettings> = {
    codememPrewarmEnabled: true,
    codememPrewarmMaxConcurrent: 2,
    codememPrewarmDebounceMs: 1500,
    codememPrewarmStartupHint: true,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      return merged[key] as AppSettings[K];
    },
  };
}

function createCodememStub() {
  const warmDeferreds = new Map<string, Deferred<{ ready: boolean; filePath: string | null }>>();
  const lastIndexedAt = new Map<string, number>();
  const target: PrewarmCodememTarget = {
    isEnabled: vi.fn(() => true),
    isIndexingEnabled: vi.fn(() => true),
    getLastIndexedAt: vi.fn((workspacePath: string) => lastIndexedAt.get(workspacePath) ?? null),
    warmWorkspace: vi.fn((workspacePath: string) => {
      const deferred = makeDeferred<{ ready: boolean; filePath: string | null }>();
      warmDeferreds.set(workspacePath, deferred);
      return deferred.promise;
    }),
  };
  return {
    target,
    /** Resolve the in-flight warmWorkspace for `path` so the coordinator can advance. */
    resolveWarm(workspacePath: string, value: { ready: boolean; filePath: string | null } = { ready: true, filePath: null }): void {
      const deferred = warmDeferreds.get(workspacePath);
      if (!deferred) {
        throw new Error(`No pending warm for ${workspacePath}`);
      }
      deferred.resolve(value);
      warmDeferreds.delete(workspacePath);
    },
    rejectWarm(workspacePath: string, error: unknown): void {
      const deferred = warmDeferreds.get(workspacePath);
      if (!deferred) {
        throw new Error(`No pending warm for ${workspacePath}`);
      }
      deferred.reject(error);
      warmDeferreds.delete(workspacePath);
    },
    setLastIndexedAt(workspacePath: string, value: number): void {
      lastIndexedAt.set(workspacePath, value);
    },
    pendingPaths(): string[] {
      return [...warmDeferreds.keys()];
    },
  };
}

/**
 * Wait for the coordinator's internal microtasks + outstanding setTimeout
 * callbacks to drain. The coordinator dispatches `warmOne` via
 * `void warmOne(...).finally(drainQueue)`; once we resolve a deferred we need
 * to let the resulting microtask chain run before asserting next-state.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('CodememPrewarmCoordinator', () => {
  let tmpRoot: string;
  let emitter: EventEmitter;
  let stub: ReturnType<typeof createCodememStub>;
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;

  function buildCoordinator(opts: Partial<CodememPrewarmCoordinatorOptions> = {}): CodememPrewarmCoordinator {
    const coordinator = new CodememPrewarmCoordinator({
      recentDirectoriesManager: emitter,
      codemem: stub.target,
      settings: createSettings(),
      ...opts,
    });
    coordinator.start();
    return coordinator;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'codemem-prewarm-test-'));
    workspaceA = path.join(tmpRoot, 'a');
    workspaceB = path.join(tmpRoot, 'b');
    workspaceC = path.join(tmpRoot, 'c');
    for (const p of [workspaceA, workspaceB, workspaceC]) {
      mkdirSync(p, { recursive: true });
    }
    emitter = new EventEmitter();
    stub = createCodememStub();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Local-vs-remote handling ────────────────────────────────────────────

  it('warms on directory-added for a local path after the debounce fires', async () => {
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    } satisfies RecentDirectoryEntry);

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
    expect(stub.target.warmWorkspace).toHaveBeenCalledWith(workspaceA, expect.any(Number));
  });

  it('skips remote entries (nodeId present)', async () => {
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
      nodeId: 'remote-uuid',
    } satisfies RecentDirectoryEntry);

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();
  });

  it('skips broad filesystem roots during automatic prewarm', async () => {
    buildCoordinator({ settings: createSettings({ codememPrewarmDebounceMs: 0 }) });

    emitter.emit('directory-added', {
      path: '/',
      displayName: '/',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    } satisfies RecentDirectoryEntry);

    await flushMicrotasks();

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();
  });

  // ── Disabled paths ──────────────────────────────────────────────────────

  it('does nothing when codemem is disabled', async () => {
    stub.target.isEnabled = vi.fn(() => false);
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing when prewarm is disabled in settings', async () => {
    buildCoordinator({ settings: createSettings({ codememPrewarmEnabled: false }) });

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();
  });

  it('does not dispatch queued warm-ups after prewarm is disabled', async () => {
    const settingsValues: Partial<AppSettings> = {
      codememPrewarmEnabled: true,
      codememPrewarmMaxConcurrent: 1,
      codememPrewarmDebounceMs: 0,
      codememPrewarmStartupHint: true,
    };
    const settings: PrewarmSettingsTarget = {
      get<K extends keyof AppSettings>(key: K): AppSettings[K] {
        return settingsValues[key] as AppSettings[K];
      },
    };
    const coordinator = buildCoordinator({ settings });

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await flushMicrotasks();

    emitter.emit('directory-added', {
      path: workspaceB,
      displayName: 'b',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
    expect(coordinator._inspectForTesting().queue).toEqual([workspaceB]);

    settingsValues.codememPrewarmEnabled = false;
    stub.resolveWarm(workspaceA);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
    expect(coordinator._inspectForTesting().queue).toEqual([]);
    expect(coordinator._inspectForTesting().active).toEqual([]);
  });

  // ── Debounce semantics ─────────────────────────────────────────────────

  it('debounces multiple events for the same path within the window', async () => {
    buildCoordinator();

    for (let i = 0; i < 3; i++) {
      emitter.emit('directory-added', {
        path: workspaceA,
        displayName: 'a',
        lastAccessed: Date.now(),
        accessCount: i + 1,
        isPinned: false,
      });
      // Each subsequent event should re-arm the debounce timer.
      await vi.advanceTimersByTimeAsync(500);
    }

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();

    // Advance past the debounce window since the last event.
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
  });

  // ── Concurrency cap ────────────────────────────────────────────────────

  it('caps concurrent warm-ups and queues additional events', async () => {
    buildCoordinator({
      settings: createSettings({ codememPrewarmMaxConcurrent: 2 }),
    });

    for (const ws of [workspaceA, workspaceB, workspaceC]) {
      emitter.emit('directory-added', {
        path: ws,
        displayName: path.basename(ws),
        lastAccessed: Date.now(),
        accessCount: 1,
        isPinned: false,
      });
    }

    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    // Only the first two should be in-flight; the third must wait.
    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(2);
    expect(stub.pendingPaths().sort()).toEqual([workspaceA, workspaceB].sort());

    // Resolve A; C should immediately fill its slot.
    stub.resolveWarm(workspaceA);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(3);
    expect(stub.pendingPaths().sort()).toEqual([workspaceB, workspaceC].sort());

    // Drain the rest to keep the test clean.
    stub.resolveWarm(workspaceB);
    stub.resolveWarm(workspaceC);
    await flushMicrotasks();
  });

  // ── hintActiveWorkspace ────────────────────────────────────────────────

  it('hintActiveWorkspace queues a path in front of pending events', async () => {
    const coordinator = buildCoordinator({
      settings: createSettings({ codememPrewarmMaxConcurrent: 1 }),
    });

    // Saturate.
    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    // Queue B via event.
    emitter.emit('directory-added', {
      path: workspaceB,
      displayName: 'b',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    // Hint C — should land at the front of the queue.
    coordinator.hintActiveWorkspace(workspaceC);
    await flushMicrotasks();

    // Inspect state: C ahead of B in the queue.
    const snapshot = coordinator._inspectForTesting();
    expect(snapshot.active).toEqual([workspaceA]);
    expect(snapshot.queue).toEqual([workspaceC, workspaceB]);

    // Resolve A; coordinator should start C (not B).
    stub.resolveWarm(workspaceA);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenNthCalledWith(2, workspaceC, expect.any(Number));

    // Drain.
    stub.resolveWarm(workspaceC);
    await flushMicrotasks();
    expect(stub.target.warmWorkspace).toHaveBeenNthCalledWith(3, workspaceB, expect.any(Number));
    stub.resolveWarm(workspaceB);
    await flushMicrotasks();
  });

  it('hintActiveWorkspace fires immediately when no warm is in progress', async () => {
    const coordinator = buildCoordinator();

    coordinator.hintActiveWorkspace(workspaceA);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
    expect(stub.target.warmWorkspace).toHaveBeenLastCalledWith(workspaceA, expect.any(Number));
  });

  // ── Already-warmed-recently dedupe ─────────────────────────────────────

  it('skips events for paths whose codemem lastIndexedAt is within the skip window', async () => {
    const coordinator = buildCoordinator({
      now: () => 100_000,
    });

    // Fire and complete first warm so it lands in warmedThisSession.
    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();
    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);

    // Simulate codemem reporting a fresh last-indexed timestamp.
    stub.setLastIndexedAt(workspaceA, 99_500); // 500ms ago vs `now: 100_000`
    stub.resolveWarm(workspaceA);
    await flushMicrotasks();

    // Second event should be debounced + dedup-skipped at enqueue time.
    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 2,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(1);
    // Sanity: the coordinator did consult the last-indexed timestamp.
    expect(stub.target.getLastIndexedAt).toHaveBeenCalled();

    coordinator.stop();
  });

  it('re-warms when lastIndexedAt is older than the skip window', async () => {
    const coordinator = buildCoordinator({
      now: () => 100_000,
      recentIndexSkipMs: 30_000,
    });

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    stub.setLastIndexedAt(workspaceA, 60_000); // 40s ago — stale
    stub.resolveWarm(workspaceA);
    await flushMicrotasks();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 2,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).toHaveBeenCalledTimes(2);

    coordinator.stop();
  });

  // ── stop() / lifecycle ────────────────────────────────────────────────

  it('stop() detaches the listener so no further events trigger warm-ups', async () => {
    const coordinator = buildCoordinator();
    coordinator.stop();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await flushMicrotasks();

    expect(stub.target.warmWorkspace).not.toHaveBeenCalled();
  });
});
