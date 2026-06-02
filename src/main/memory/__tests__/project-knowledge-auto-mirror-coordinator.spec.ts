/**
 * Unit tests for `ProjectKnowledgeAutoMirrorCoordinator`.
 *
 * Strategy:
 *   - Inject a plain `EventEmitter` in place of the real
 *     `RecentDirectoriesManager` so we don't pull in `electron-store`.
 *   - Inject fake knowledge / bridge / codemem / registry / settings targets
 *     so we don't need to spin up the RLM, codemem worker, or
 *     `ProjectKnowledgeCoordinator` singleton.
 *   - Use deferred `ensureProjectKnown` promises so queue/concurrency
 *     behaviour is observable deterministically without timing flakes.
 *   - Use real temp directories so the coordinator's `fs.statSync` belt &
 *     braces directory check passes.
 *
 * Mirrors the test design of `CodememPrewarmCoordinator`'s spec, which has
 * proven that pattern reliable on Vitest's fake timers.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectKnowledgeAutoMirrorCoordinator,
  type AutoMirrorBridgeTarget,
  type AutoMirrorCodememTarget,
  type AutoMirrorKnowledgeTarget,
  type AutoMirrorRegistryTarget,
  type AutoMirrorSettingsTarget,
  type ProjectKnowledgeAutoMirrorCoordinatorOptions,
} from '../project-knowledge-auto-mirror-coordinator';
import type { AppSettings } from '../../../shared/types/settings.types';
import type { RecentDirectoryEntry } from '../../../shared/types/recent-directories.types';
import type {
  CodebaseMiningResult,
  ProjectCodeIndexStatus,
} from '../../../shared/types/knowledge-graph.types';
import { flushMicrotasks, makeDeferred, type Deferred } from './auto-mirror-test-helpers';

function createSettings(overrides: Partial<AppSettings> = {}): AutoMirrorSettingsTarget {
  const defaults: Partial<AppSettings> = {
    projectKnowledgeAutoMirrorEnabled: true,
    projectKnowledgeAutoMirrorDebounceMs: 2_000,
    projectKnowledgeAutoMirrorMaxConcurrent: 2,
    projectKnowledgeAutoMirrorSkipWithinMs: 30_000,
    projectKnowledgeAutoMirrorStartupHint: true,
  };
  const merged = { ...defaults, ...overrides };
  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      return merged[key] as AppSettings[K];
    },
  };
}

function createKnowledgeStub() {
  const ensureDeferreds = new Map<string, Deferred<CodebaseMiningResult>>();
  const target: AutoMirrorKnowledgeTarget = {
    ensureProjectKnown: vi.fn((rootPath: string) => {
      const deferred = makeDeferred<CodebaseMiningResult>();
      ensureDeferreds.set(rootPath, deferred);
      return deferred.promise;
    }),
  };
  return {
    target,
    resolveMirror(rootPath: string): void {
      const deferred = ensureDeferreds.get(rootPath);
      if (!deferred) {
        throw new Error(`No pending mirror for ${rootPath}`);
      }
      deferred.resolve({
        normalizedPath: rootPath,
        rootPath,
        projectKey: rootPath,
        status: 'completed',
        factsExtracted: 0,
        hintsCreated: 0,
        filesRead: 0,
        errors: [],
      } satisfies CodebaseMiningResult);
      ensureDeferreds.delete(rootPath);
    },
    rejectMirror(rootPath: string, error: unknown): void {
      const deferred = ensureDeferreds.get(rootPath);
      if (!deferred) {
        throw new Error(`No pending mirror for ${rootPath}`);
      }
      deferred.reject(error);
      ensureDeferreds.delete(rootPath);
    },
    pendingPaths(): string[] {
      return [...ensureDeferreds.keys()];
    },
  };
}

function createBridge(statusByKey: Map<string, ProjectCodeIndexStatus>): AutoMirrorBridgeTarget {
  return {
    getStatus: vi.fn((projectKey: string) =>
      statusByKey.get(projectKey) ?? ({
        projectKey,
        status: 'never',
        updatedAt: 0,
        metadata: {},
      } satisfies ProjectCodeIndexStatus),
    ),
  };
}

function createCodemem(overrides?: Partial<AutoMirrorCodememTarget>): AutoMirrorCodememTarget {
  const emitter = new EventEmitter() as EventEmitter & AutoMirrorCodememTarget;
  emitter.isEnabled = vi.fn(() => true);
  emitter.isIndexingEnabled = vi.fn(() => true);
  return Object.assign(emitter, overrides);
}

function createRegistry(canAutoMineByPath: Map<string, boolean>): AutoMirrorRegistryTarget {
  return {
    canAutoMine: vi.fn((rootPath: string) => canAutoMineByPath.get(rootPath) ?? true),
  };
}

describe('ProjectKnowledgeAutoMirrorCoordinator', () => {
  let tmpRoot: string;
  let emitter: EventEmitter;
  let knowledge: ReturnType<typeof createKnowledgeStub>;
  let codemem: AutoMirrorCodememTarget;
  let statusByKey: Map<string, ProjectCodeIndexStatus>;
  let bridge: AutoMirrorBridgeTarget;
  let canAutoMineByPath: Map<string, boolean>;
  let registry: AutoMirrorRegistryTarget;
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;

  function buildCoordinator(
    opts: Partial<ProjectKnowledgeAutoMirrorCoordinatorOptions> = {},
  ): ProjectKnowledgeAutoMirrorCoordinator {
    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings(),
      // Use a stable resolver — tests pass already-absolute temp paths so
      // path.resolve(...) round-trips them. Default uses the same logic.
      projectKeyResolver: (p) => path.resolve(p),
      ...opts,
    });
    coordinator.start();
    return coordinator;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'project-knowledge-mirror-test-'));
    workspaceA = path.join(tmpRoot, 'a');
    workspaceB = path.join(tmpRoot, 'b');
    workspaceC = path.join(tmpRoot, 'c');
    for (const p of [workspaceA, workspaceB, workspaceC]) {
      mkdirSync(p, { recursive: true });
    }
    emitter = new EventEmitter();
    knowledge = createKnowledgeStub();
    codemem = createCodemem();
    statusByKey = new Map();
    bridge = createBridge(statusByKey);
    canAutoMineByPath = new Map();
    registry = createRegistry(canAutoMineByPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Local-vs-remote handling ────────────────────────────────────────────

  it('mirrors on directory-added for a local path after the debounce fires', async () => {
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    } satisfies RecentDirectoryEntry);

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(1);
    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledWith(
      workspaceA,
      'recent-directory-open',
      { autoRefresh: true },
    );
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

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
  });

  it('skips broad filesystem roots during automatic mirror', async () => {
    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorDebounceMs: 0 }),
      projectKeyResolver: (p) => path.resolve(p),
    });
    coordinator.start();

    emitter.emit('directory-added', {
      path: '/',
      displayName: '/',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    } satisfies RecentDirectoryEntry);

    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
    coordinator.stop();
  });

  // ── Disabled paths ──────────────────────────────────────────────────────

  it('does nothing when projectKnowledgeAutoMirrorEnabled is false', async () => {
    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorEnabled: false }),
      projectKeyResolver: (p) => path.resolve(p),
    });
    coordinator.start();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
  });

  it('does nothing when codemem is disabled', async () => {
    codemem.isEnabled = vi.fn(() => false);
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
  });

  it('does nothing when codemem indexing is disabled', async () => {
    codemem.isIndexingEnabled = vi.fn(() => false);
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
  });

  it('skips paths that canAutoMine rejects (paused/excluded/autoMine=false)', async () => {
    canAutoMineByPath.set(workspaceA, false);
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(800);
    }

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();

    // Advance past the debounce window since the last event.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(1);
  });

  // ── Concurrency cap ────────────────────────────────────────────────────

  it('caps concurrent mirrors and queues additional events', async () => {
    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      // Use the smaller cap of 2 so we can deterministically observe the
      // third path being queued.
      settings: createSettings({ projectKnowledgeAutoMirrorMaxConcurrent: 2 }),
      projectKeyResolver: (p) => path.resolve(p),
    });
    coordinator.start();

    for (const ws of [workspaceA, workspaceB, workspaceC]) {
      emitter.emit('directory-added', {
        path: ws,
        displayName: path.basename(ws),
        lastAccessed: Date.now(),
        accessCount: 1,
        isPinned: false,
      });
    }

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // Only the first two should be in-flight; the third must wait.
    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(2);
    expect(knowledge.pendingPaths().sort()).toEqual([workspaceA, workspaceB].sort());

    // Resolve A; C should immediately fill its slot.
    knowledge.resolveMirror(workspaceA);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(3);
    expect(knowledge.pendingPaths().sort()).toEqual([workspaceB, workspaceC].sort());

    // Drain the rest to keep the test clean.
    knowledge.resolveMirror(workspaceB);
    knowledge.resolveMirror(workspaceC);
    await flushMicrotasks();
  });

  // ── lastSyncedAt short-circuit ─────────────────────────────────────────

  it('skips when bridge.lastSyncedAt is within the skip window', async () => {
    statusByKey.set(workspaceA, {
      projectKey: workspaceA,
      status: 'ready',
      lastSyncedAt: 99_500, // 500ms ago vs `now: 100_000`
      updatedAt: 99_500,
      metadata: {},
    });

    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorSkipWithinMs: 30_000 }),
      projectKeyResolver: (p) => path.resolve(p),
      now: () => 100_000,
    });
    coordinator.start();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it('forces a mirror when codemem reports indexed code changes inside the skip window', async () => {
    statusByKey.set(workspaceA, {
      projectKey: workspaceA,
      status: 'ready',
      lastSyncedAt: 99_500,
      updatedAt: 99_500,
      metadata: {},
    });

    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorSkipWithinMs: 30_000 }),
      projectKeyResolver: (p) => path.resolve(p),
      now: () => 100_000,
    });
    coordinator.start();

    (codemem as EventEmitter).emit('code-index:changed', {
      workspacePath: workspaceA,
      workspaceHash: 'hash-a',
      paths: ['src/auth/middleware.ts'],
      timestamp: 100_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledWith(
      workspaceA,
      'recent-directory-open',
      { autoRefresh: true },
    );
    coordinator.stop();
  });

  it('re-mirrors when bridge.lastSyncedAt is older than the skip window', async () => {
    statusByKey.set(workspaceA, {
      projectKey: workspaceA,
      status: 'ready',
      lastSyncedAt: 60_000, // 40s ago at now=100_000 — stale
      updatedAt: 60_000,
      metadata: {},
    });

    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorSkipWithinMs: 30_000 }),
      projectKeyResolver: (p) => path.resolve(p),
      now: () => 100_000,
    });
    coordinator.start();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(1);
    knowledge.resolveMirror(workspaceA);
    await flushMicrotasks();
    coordinator.stop();
  });

  it('skips fresh limit_exceeded failures using updatedAt to avoid retry loops', async () => {
    statusByKey.set(workspaceA, {
      projectKey: workspaceA,
      status: 'failed',
      error: 'Code index file count limit exceeded.',
      updatedAt: 99_500,
      metadata: { reason: 'limit_exceeded', limit: 'files' },
    });

    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorSkipWithinMs: 30_000 }),
      projectKeyResolver: (p) => path.resolve(p),
      now: () => 100_000,
    });
    coordinator.start();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
    coordinator.stop();
  });

  // ── hintActiveWorkspace ────────────────────────────────────────────────

  it('hintActiveWorkspace queues a path in front of pending events', async () => {
    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorMaxConcurrent: 1 }),
      projectKeyResolver: (p) => path.resolve(p),
    });
    coordinator.start();

    // Saturate.
    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // Queue B via event.
    emitter.emit('directory-added', {
      path: workspaceB,
      displayName: 'b',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // Hint C — should land at the front of the queue.
    coordinator.hintActiveWorkspace(workspaceC);
    await flushMicrotasks();

    // Inspect state: C ahead of B in the queue.
    const snapshot = coordinator._inspectForTesting();
    expect(snapshot.active).toEqual([workspaceA]);
    expect(snapshot.queue).toEqual([workspaceC, workspaceB]);

    // Resolve A; coordinator should start C (not B).
    knowledge.resolveMirror(workspaceA);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenNthCalledWith(
      2,
      workspaceC,
      'recent-directory-open',
      { autoRefresh: true },
    );

    // Drain.
    knowledge.resolveMirror(workspaceC);
    await flushMicrotasks();
    expect(knowledge.target.ensureProjectKnown).toHaveBeenNthCalledWith(
      3,
      workspaceB,
      'recent-directory-open',
      { autoRefresh: true },
    );
    knowledge.resolveMirror(workspaceB);
    await flushMicrotasks();
  });

  it('hintActiveWorkspace fires immediately when no mirror is in progress', async () => {
    const coordinator = buildCoordinator();

    coordinator.hintActiveWorkspace(workspaceA);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(1);
    expect(knowledge.target.ensureProjectKnown).toHaveBeenLastCalledWith(
      workspaceA,
      'recent-directory-open',
      { autoRefresh: true },
    );
  });

  it('hintActiveWorkspace respects the lastSyncedAt short-circuit', async () => {
    statusByKey.set(workspaceA, {
      projectKey: workspaceA,
      status: 'ready',
      lastSyncedAt: 99_500,
      updatedAt: 99_500,
      metadata: {},
    });

    const coordinator = new ProjectKnowledgeAutoMirrorCoordinator({
      recentDirectoriesManager: emitter,
      knowledge: knowledge.target,
      bridge,
      codemem,
      registry,
      settings: createSettings({ projectKnowledgeAutoMirrorSkipWithinMs: 30_000 }),
      projectKeyResolver: (p) => path.resolve(p),
      now: () => 100_000,
    });
    coordinator.start();

    coordinator.hintActiveWorkspace(workspaceA);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
    coordinator.stop();
  });

  // ── Failure handling ───────────────────────────────────────────────────

  it('continues processing the queue after a mirror rejects', async () => {
    buildCoordinator();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    emitter.emit('directory-added', {
      path: workspaceB,
      displayName: 'b',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).toHaveBeenCalledTimes(2);

    // Reject A — the coordinator should swallow the error and the queue
    // should keep draining (B already in-flight; nothing new to test
    // beyond "no unhandled rejection blows the test up").
    knowledge.rejectMirror(workspaceA, new Error('boom'));
    await flushMicrotasks();

    knowledge.resolveMirror(workspaceB);
    await flushMicrotasks();

    // Nothing left in flight.
    expect(knowledge.pendingPaths()).toEqual([]);
  });

  // ── stop() / lifecycle ────────────────────────────────────────────────

  it('stop() detaches the listener so no further events trigger mirrors', async () => {
    const coordinator = buildCoordinator();
    coordinator.stop();

    emitter.emit('directory-added', {
      path: workspaceA,
      displayName: 'a',
      lastAccessed: Date.now(),
      accessCount: 1,
      isPinned: false,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(knowledge.target.ensureProjectKnown).not.toHaveBeenCalled();
  });
});
