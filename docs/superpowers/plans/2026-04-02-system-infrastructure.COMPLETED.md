# System Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add build-time feature gating, file-change-based cache invalidation, parallel startup optimization, comprehensive lifecycle hooks, and a versioned migration system — inspired by Claude Code's infrastructure patterns.

**Architecture:** The existing `ORCHESTRATION_FEATURES` flags get replaced with a build-time dead-code-elimination system using TypeScript const enums and tree-shaking. File-watcher-based cache invalidation replaces TTL polling. Startup I/O operations get parallelized. The hook system gets lifecycle events for pre/post sampling. A migration system tracks config schema versions.

**Tech Stack:** TypeScript, chokidar (file watching), Node.js, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/shared/constants/feature-flags.ts` | Build-time feature flag system with const enum |
| Create | `src/main/tools/file-watcher-cache.ts` | File-change-based cache invalidation |
| Create | `src/main/tools/file-watcher-cache.spec.ts` | Tests for file watcher cache |
| Create | `src/main/core/startup-optimizer.ts` | Parallel startup I/O |
| Create | `src/main/core/startup-optimizer.spec.ts` | Tests for startup optimizer |
| Create | `src/main/core/migration-manager.ts` | Versioned config migration |
| Create | `src/main/core/migration-manager.spec.ts` | Tests for migration manager |
| Modify | `src/shared/types/hook.types.ts` | Add PreSampling/PostSampling hook events |
| Modify | `src/main/hooks/hook-manager.ts` | Support new lifecycle hook events |

---

### Task 1: Enhanced Feature Flags with Build-Time Elimination

**Files:**
- Modify: `src/shared/constants/feature-flags.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/shared/constants/feature-flags.spec.ts
import { describe, it, expect } from 'vitest';
import { ORCHESTRATION_FEATURES, isFeatureEnabled, FeatureFlag } from './feature-flags';

describe('Feature Flags', () => {
  it('has all required feature flags', () => {
    expect(ORCHESTRATION_FEATURES.DEBATE_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.VERIFICATION_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.CONSENSUS_SYSTEM).toBeDefined();
    expect(ORCHESTRATION_FEATURES.PARALLEL_WORKTREE).toBeDefined();
  });

  it('has new infrastructure flags', () => {
    expect(ORCHESTRATION_FEATURES.STREAMING_TOOLS).toBeDefined();
    expect(ORCHESTRATION_FEATURES.LAYERED_COMPACTION).toBeDefined();
    expect(ORCHESTRATION_FEATURES.ERROR_WITHHOLDING).toBeDefined();
    expect(ORCHESTRATION_FEATURES.TOKEN_BUDGET).toBeDefined();
    expect(ORCHESTRATION_FEATURES.FILE_WATCHER_CACHE).toBeDefined();
  });

  it('isFeatureEnabled returns boolean', () => {
    const result = isFeatureEnabled('DEBATE_SYSTEM');
    expect(typeof result).toBe('boolean');
  });

  it('isFeatureEnabled respects environment overrides', () => {
    process.env['ORCH_FEATURE_DEBATE_SYSTEM'] = 'false';
    expect(isFeatureEnabled('DEBATE_SYSTEM')).toBe(false);
    delete process.env['ORCH_FEATURE_DEBATE_SYSTEM'];
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/constants/feature-flags.spec.ts`
Expected: FAIL (missing new flags and isFeatureEnabled)

- [ ] **Step 3: Write the implementation**

```typescript
// src/shared/constants/feature-flags.ts
/**
 * Feature flags for optional orchestration systems.
 *
 * Enhanced with:
 * - Environment variable overrides (ORCH_FEATURE_<FLAG>=true/false)
 * - Runtime-checkable helper function
 * - New flags for infrastructure improvements
 *
 * Inspired by Claude Code's bundle-time feature() system.
 * In our Electron build, these are runtime-checked but the pattern
 * supports tree-shaking in future Vite/esbuild compilation.
 */

export const ORCHESTRATION_FEATURES = {
  // Existing coordination systems
  DEBATE_SYSTEM: true,
  VERIFICATION_SYSTEM: true,
  CONSENSUS_SYSTEM: true,
  PARALLEL_WORKTREE: true,

  // New infrastructure features
  STREAMING_TOOLS: true,
  LAYERED_COMPACTION: true,
  ERROR_WITHHOLDING: true,
  TOKEN_BUDGET: true,
  FILE_WATCHER_CACHE: true,
  LIFECYCLE_HOOKS: true,
} as const;

export type FeatureFlag = keyof typeof ORCHESTRATION_FEATURES;

/**
 * Check if a feature flag is enabled, with environment variable override.
 * Environment: ORCH_FEATURE_<FLAG_NAME>=true|false
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  const envKey = `ORCH_FEATURE_${flag}`;
  const envValue = process.env[envKey];

  if (envValue !== undefined) {
    return envValue.toLowerCase() !== 'false' && envValue !== '0';
  }

  return ORCHESTRATION_FEATURES[flag];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/constants/feature-flags.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants/feature-flags.ts src/shared/constants/feature-flags.spec.ts
git commit -m "feat(flags): enhance feature flags with env overrides and new infrastructure flags"
```

---

### Task 2: File-Watcher-Based Cache Invalidation

**Files:**
- Create: `src/main/tools/file-watcher-cache.ts`
- Create: `src/main/tools/file-watcher-cache.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/tools/file-watcher-cache.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileWatcherCache } from './file-watcher-cache';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('FileWatcherCache', () => {
  let cache: FileWatcherCache<string>;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fwc-test-'));
    cache = new FileWatcherCache<string>();
  });

  afterEach(async () => {
    cache.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('caches a value and returns it', async () => {
    const loader = vi.fn(async () => 'hello');
    const result = await cache.get('key1', tmpDir, loader);
    expect(result).toBe('hello');
    expect(loader).toHaveBeenCalledOnce();
  });

  it('returns cached value without re-loading', async () => {
    const loader = vi.fn(async () => 'hello');
    await cache.get('key1', tmpDir, loader);
    const result = await cache.get('key1', tmpDir, loader);
    expect(result).toBe('hello');
    expect(loader).toHaveBeenCalledOnce(); // Not called again
  });

  it('invalidates cache when file changes', async () => {
    const testFile = path.join(tmpDir, 'tool.js');
    await fs.writeFile(testFile, 'v1');

    let version = 1;
    const loader = vi.fn(async () => `version-${version++}`);

    // Initial load
    const r1 = await cache.get('key1', tmpDir, loader);
    expect(r1).toBe('version-1');

    // Trigger file change
    await fs.writeFile(testFile, 'v2');

    // Wait for fs.watch debounce
    await new Promise(r => setTimeout(r, 300));

    // Should reload
    const r2 = await cache.get('key1', tmpDir, loader);
    expect(r2).toBe('version-2');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('clears cache manually', async () => {
    const loader = vi.fn(async () => 'hello');
    await cache.get('key1', tmpDir, loader);
    cache.invalidate('key1');
    await cache.get('key1', tmpDir, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/tools/file-watcher-cache.spec.ts`
Expected: FAIL with "Cannot find module './file-watcher-cache'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/tools/file-watcher-cache.ts
/**
 * File-Watcher-Based Cache
 *
 * Replaces TTL-based polling with fs.watch-based invalidation.
 * Cache entries are invalidated when watched directories change.
 *
 * Inspired by Claude Code's settingsChangeDetector and skillChangeDetector
 * which use file watchers to invalidate memoized caches.
 */

import * as fs from 'fs';
import { getLogger } from '../logging/logger';

const logger = getLogger('FileWatcherCache');

/** Debounce file system events (ms) */
const DEBOUNCE_MS = 200;

interface CacheEntry<T> {
  value: T;
  loadedAt: number;
}

export class FileWatcherCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private watchers = new Map<string, fs.FSWatcher>();
  private invalidatedKeys = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  /**
   * Get a cached value, loading it if not present or invalidated.
   * @param key Cache key
   * @param watchDir Directory to watch for changes
   * @param loader Function to load the value
   */
  async get(key: string, watchDir: string, loader: () => Promise<T>): Promise<T> {
    // Start watching the directory if not already
    this.ensureWatching(key, watchDir);

    const cached = this.cache.get(key);
    if (cached && !this.invalidatedKeys.has(key)) {
      return cached.value;
    }

    // Load fresh value
    const value = await loader();
    this.cache.set(key, { value, loadedAt: Date.now() });
    this.invalidatedKeys.delete(key);
    return value;
  }

  /**
   * Manually invalidate a cache entry.
   */
  invalidate(key: string): void {
    this.invalidatedKeys.add(key);
  }

  /**
   * Invalidate all entries.
   */
  invalidateAll(): void {
    for (const key of this.cache.keys()) {
      this.invalidatedKeys.add(key);
    }
  }

  /**
   * Dispose all watchers and clear cache.
   */
  dispose(): void {
    this.disposed = true;
    for (const [, watcher] of this.watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.watchers.clear();
    this.cache.clear();
    this.invalidatedKeys.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private ensureWatching(key: string, watchDir: string): void {
    if (this.disposed) return;
    if (this.watchers.has(key)) return;

    try {
      // Check directory exists before watching
      if (!fs.existsSync(watchDir)) return;

      const watcher = fs.watch(watchDir, { recursive: true }, (_eventType, _filename) => {
        // Debounce rapid changes
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(key, setTimeout(() => {
          this.invalidatedKeys.add(key);
          this.debounceTimers.delete(key);
          logger.debug('Cache invalidated by file change', { key, watchDir });
        }, DEBOUNCE_MS));
      });

      watcher.on('error', (err) => {
        logger.warn('File watcher error', { key, error: err.message });
        // Don't crash — just invalidate and remove watcher
        this.invalidatedKeys.add(key);
        this.watchers.delete(key);
      });

      this.watchers.set(key, watcher);
    } catch (err) {
      logger.warn('Failed to start file watcher', {
        key,
        watchDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/tools/file-watcher-cache.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/file-watcher-cache.ts src/main/tools/file-watcher-cache.spec.ts
git commit -m "feat(tools): add file-watcher-based cache invalidation replacing TTL polling"
```

---

### Task 3: Parallel Startup Optimizer

**Files:**
- Create: `src/main/core/startup-optimizer.ts`
- Create: `src/main/core/startup-optimizer.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/core/startup-optimizer.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { StartupOptimizer, type StartupTask } from './startup-optimizer';

describe('StartupOptimizer', () => {
  it('runs independent tasks in parallel', async () => {
    const startTimes: Record<string, number> = {};

    const tasks: StartupTask[] = [
      {
        name: 'taskA',
        phase: 'immediate',
        fn: async () => { startTimes['taskA'] = Date.now(); await new Promise(r => setTimeout(r, 50)); },
      },
      {
        name: 'taskB',
        phase: 'immediate',
        fn: async () => { startTimes['taskB'] = Date.now(); await new Promise(r => setTimeout(r, 50)); },
      },
    ];

    const optimizer = new StartupOptimizer(tasks);
    await optimizer.runPhase('immediate');

    // Both should have started within 20ms of each other
    expect(Math.abs(startTimes['taskA'] - startTimes['taskB'])).toBeLessThan(30);
  });

  it('defers tasks to later phases', async () => {
    const executed: string[] = [];

    const tasks: StartupTask[] = [
      { name: 'critical', phase: 'immediate', fn: async () => { executed.push('critical'); } },
      { name: 'deferred', phase: 'afterFirstRender', fn: async () => { executed.push('deferred'); } },
    ];

    const optimizer = new StartupOptimizer(tasks);
    await optimizer.runPhase('immediate');

    expect(executed).toEqual(['critical']);

    await optimizer.runPhase('afterFirstRender');
    expect(executed).toEqual(['critical', 'deferred']);
  });

  it('captures errors without blocking other tasks', async () => {
    const tasks: StartupTask[] = [
      { name: 'fail', phase: 'immediate', fn: async () => { throw new Error('boom'); } },
      { name: 'succeed', phase: 'immediate', fn: async () => 'ok' },
    ];

    const optimizer = new StartupOptimizer(tasks);
    const results = await optimizer.runPhase('immediate');

    expect(results.find(r => r.name === 'fail')?.error).toBe('boom');
    expect(results.find(r => r.name === 'succeed')?.success).toBe(true);
  });

  it('tracks timing for each task', async () => {
    const tasks: StartupTask[] = [
      { name: 'fast', phase: 'immediate', fn: async () => { await new Promise(r => setTimeout(r, 10)); } },
    ];

    const optimizer = new StartupOptimizer(tasks);
    const results = await optimizer.runPhase('immediate');

    expect(results[0].durationMs).toBeGreaterThanOrEqual(5);
    expect(results[0].durationMs).toBeLessThan(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/startup-optimizer.spec.ts`
Expected: FAIL with "Cannot find module './startup-optimizer'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/core/startup-optimizer.ts
/**
 * Startup Optimizer
 *
 * Parallelizes independent startup I/O operations across phases.
 * Critical tasks run immediately; heavy initialization defers until after first render.
 *
 * Inspired by Claude Code's parallel startup patterns:
 * - startMdmRawRead() and startKeychainPrefetch() during module evaluation
 * - startDeferredPrefetches() after first render
 * - prefetchAwsCredentials() and prefetchGcpCredentials() in parallel
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('StartupOptimizer');

export type StartupPhase = 'immediate' | 'afterFirstRender' | 'onDemand';

export interface StartupTask {
  name: string;
  phase: StartupPhase;
  fn: () => Promise<unknown>;
  /** Optional: only run if condition is true */
  condition?: () => boolean;
}

export interface TaskResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

export class StartupOptimizer {
  private tasks: StartupTask[];
  private completedPhases = new Set<StartupPhase>();

  constructor(tasks: StartupTask[]) {
    this.tasks = tasks;
  }

  /**
   * Run all tasks for a given phase in parallel.
   * Returns results for all tasks (including errors).
   */
  async runPhase(phase: StartupPhase): Promise<TaskResult[]> {
    if (this.completedPhases.has(phase)) {
      logger.warn('Phase already completed', { phase });
      return [];
    }

    const phaseTasks = this.tasks.filter(t => t.phase === phase);
    const applicableTasks = phaseTasks.filter(t => !t.condition || t.condition());

    logger.info('Running startup phase', {
      phase,
      taskCount: applicableTasks.length,
      taskNames: applicableTasks.map(t => t.name),
    });

    const startTime = Date.now();

    const results = await Promise.all(
      applicableTasks.map(async (task): Promise<TaskResult> => {
        const taskStart = Date.now();
        try {
          await task.fn();
          const durationMs = Date.now() - taskStart;
          return { name: task.name, success: true, durationMs };
        } catch (err) {
          const durationMs = Date.now() - taskStart;
          const error = err instanceof Error ? err.message : String(err);
          logger.warn('Startup task failed', { task: task.name, error, durationMs });
          return { name: task.name, success: false, durationMs, error };
        }
      })
    );

    const totalMs = Date.now() - startTime;
    this.completedPhases.add(phase);

    logger.info('Startup phase completed', {
      phase,
      totalMs,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });

    return results;
  }

  /**
   * Get all registered task names by phase.
   */
  getTasksByPhase(): Record<StartupPhase, string[]> {
    const result: Record<StartupPhase, string[]> = {
      immediate: [],
      afterFirstRender: [],
      onDemand: [],
    };

    for (const task of this.tasks) {
      result[task.phase].push(task.name);
    }

    return result;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/startup-optimizer.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/core/startup-optimizer.ts src/main/core/startup-optimizer.spec.ts
git commit -m "feat(core): add startup optimizer for parallel initialization"
```

---

### Task 4: Migration Manager

**Files:**
- Create: `src/main/core/migration-manager.ts`
- Create: `src/main/core/migration-manager.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/core/migration-manager.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MigrationManager, type Migration } from './migration-manager';

describe('MigrationManager', () => {
  let manager: MigrationManager;
  const migrations: Migration[] = [
    {
      version: 1,
      name: 'add-default-provider',
      up: vi.fn(async (config: any) => ({ ...config, defaultProvider: 'claude-cli' })),
    },
    {
      version: 2,
      name: 'rename-model-field',
      up: vi.fn(async (config: any) => {
        const { model, ...rest } = config;
        return { ...rest, modelId: model || 'claude-sonnet' };
      }),
    },
    {
      version: 3,
      name: 'add-token-budget',
      up: vi.fn(async (config: any) => ({ ...config, tokenBudget: 200000 })),
    },
  ];

  beforeEach(() => {
    manager = new MigrationManager(migrations);
  });

  it('runs all migrations from version 0', async () => {
    const config = { model: 'claude-3' };
    const result = await manager.migrate(config, 0);

    expect(result.config).toEqual({
      modelId: 'claude-3',
      defaultProvider: 'claude-cli',
      tokenBudget: 200000,
    });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(3);
    expect(result.migrationsRun).toBe(3);
  });

  it('runs only pending migrations', async () => {
    const config = { defaultProvider: 'claude-cli', model: 'claude-3' };
    const result = await manager.migrate(config, 1);

    expect(result.migrationsRun).toBe(2);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(3);
    expect(migrations[0].up).not.toHaveBeenCalled();
  });

  it('returns unchanged config if already current', async () => {
    const config = { modelId: 'claude-3', defaultProvider: 'claude-cli', tokenBudget: 200000 };
    const result = await manager.migrate(config, 3);

    expect(result.migrationsRun).toBe(0);
    expect(result.config).toEqual(config);
  });

  it('returns current version number', () => {
    expect(manager.getCurrentVersion()).toBe(3);
  });

  it('handles migration errors gracefully', async () => {
    const failingMigrations: Migration[] = [
      {
        version: 1,
        name: 'good-migration',
        up: vi.fn(async (config: any) => ({ ...config, added: true })),
      },
      {
        version: 2,
        name: 'bad-migration',
        up: vi.fn(async () => { throw new Error('migration failed'); }),
      },
    ];

    const mgr = new MigrationManager(failingMigrations);
    const result = await mgr.migrate({}, 0);

    // Should stop at the failed migration and report it
    expect(result.error).toBe('migration failed');
    expect(result.migrationsRun).toBe(1);
    expect(result.toVersion).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/migration-manager.spec.ts`
Expected: FAIL with "Cannot find module './migration-manager'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/core/migration-manager.ts
/**
 * Migration Manager
 *
 * Versioned migration system for config/settings evolution.
 * Runs pending migrations sequentially on startup when version mismatch detected.
 *
 * Inspired by Claude Code's CURRENT_MIGRATION_VERSION + runMigrations() pattern
 * with named migrations like migrateSonnet45ToSonnet46.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('MigrationManager');

export interface Migration {
  version: number;
  name: string;
  up: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface MigrationResult {
  config: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  migrationsRun: number;
  migrationNames: string[];
  error?: string;
}

export class MigrationManager {
  private migrations: Migration[];

  constructor(migrations: Migration[]) {
    // Sort by version ascending
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
  }

  /**
   * Get the highest migration version available.
   */
  getCurrentVersion(): number {
    if (this.migrations.length === 0) return 0;
    return this.migrations[this.migrations.length - 1].version;
  }

  /**
   * Run all pending migrations from currentVersion to latest.
   * Stops on first error and returns partial result.
   */
  async migrate(
    config: Record<string, unknown>,
    currentVersion: number
  ): Promise<MigrationResult> {
    const pending = this.migrations.filter(m => m.version > currentVersion);

    if (pending.length === 0) {
      return {
        config,
        fromVersion: currentVersion,
        toVersion: currentVersion,
        migrationsRun: 0,
        migrationNames: [],
      };
    }

    logger.info('Running migrations', {
      from: currentVersion,
      pending: pending.length,
      names: pending.map(m => m.name),
    });

    let current = { ...config };
    let lastSuccessVersion = currentVersion;
    const runNames: string[] = [];

    for (const migration of pending) {
      try {
        logger.info('Running migration', { version: migration.version, name: migration.name });
        current = await migration.up(current);
        lastSuccessVersion = migration.version;
        runNames.push(migration.name);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Migration failed', {
          version: migration.version,
          name: migration.name,
          error,
        });
        return {
          config: current,
          fromVersion: currentVersion,
          toVersion: lastSuccessVersion,
          migrationsRun: runNames.length,
          migrationNames: runNames,
          error,
        };
      }
    }

    logger.info('All migrations completed', {
      from: currentVersion,
      to: lastSuccessVersion,
      count: runNames.length,
    });

    return {
      config: current,
      fromVersion: currentVersion,
      toVersion: lastSuccessVersion,
      migrationsRun: runNames.length,
      migrationNames: runNames,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/core/migration-manager.spec.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/core/migration-manager.ts src/main/core/migration-manager.spec.ts
git commit -m "feat(core): add versioned migration manager for config evolution"
```

---

### Task 5: Lifecycle Hook Events (Pre/Post Sampling)

**Files:**
- Modify: `src/shared/types/hook.types.ts`
- Modify: `src/main/hooks/hook-manager.ts`

- [ ] **Step 1: Add new hook events to types**

In `src/shared/types/hook.types.ts`, add to the `HookEvent` type:

```typescript
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreSampling'      // NEW: Before API call to model
  | 'PostSampling'     // NEW: After model response, before tool execution
  | 'Stop'
  | 'StopFailure'
  | 'PostCompact'
  | 'CwdChanged'
  | 'FileChanged'
  | 'SessionStart'
  | 'SessionEnd'
  | 'BeforeCommit'
  | 'UserPromptSubmit';
```

Add to `HookContext`:

```typescript
  // PreSampling context
  messageCount?: number;
  estimatedTokens?: number;

  // PostSampling context
  modelResponse?: string;
  responseTokens?: number;
  modelId?: string;
```

- [ ] **Step 2: Verify hook manager handles new events without code changes**

The existing `HookManager.triggerHooks()` method is generic — it matches hooks by event type. The new events should work without `HookManager` modifications since it filters by `hook.event === event`.

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Write a test confirming new events work end-to-end**

```typescript
// Add to an existing hook test or create src/main/hooks/__tests__/lifecycle-hooks.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../hook-manager';

describe('Lifecycle Hook Events', () => {
  beforeEach(() => {
    HookManager._resetForTesting();
  });

  it('triggers PreSampling hooks', async () => {
    const manager = HookManager.getInstance();
    const handler = vi.fn();
    manager.on('hook:executed', handler);

    manager.registerHook({
      id: 'pre-sampling-test',
      event: 'PreSampling',
      enabled: true,
      type: 'shell',
      command: 'echo "pre-sampling"',
    });

    const results = await manager.triggerHooks('PreSampling', {
      instanceId: 'test',
      messageCount: 10,
      estimatedTokens: 5000,
    });

    expect(results).toHaveLength(1);
  });

  it('triggers PostSampling hooks', async () => {
    const manager = HookManager.getInstance();

    manager.registerHook({
      id: 'post-sampling-test',
      event: 'PostSampling',
      enabled: true,
      type: 'shell',
      command: 'echo "post-sampling"',
    });

    const results = await manager.triggerHooks('PostSampling', {
      instanceId: 'test',
      modelResponse: 'I will help you...',
      responseTokens: 500,
      modelId: 'claude-sonnet',
    });

    expect(results).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/hooks/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/hook.types.ts src/main/hooks/
git commit -m "feat(hooks): add PreSampling and PostSampling lifecycle hook events"
```

---

### Task 6: Final Integration and Exports

**Files:**
- Modify: `src/main/tools/index.ts` (add file watcher export)
- Modify: `src/main/core/index.ts` (add startup optimizer and migration manager)

- [ ] **Step 1: Update tool exports**

Append to `src/main/tools/index.ts`:

```typescript
export { FileWatcherCache } from './file-watcher-cache';
```

- [ ] **Step 2: Update core exports**

In `src/main/core/index.ts`, add:

```typescript
export { StartupOptimizer, type StartupTask, type StartupPhase, type TaskResult } from './startup-optimizer';
export { MigrationManager, type Migration, type MigrationResult } from './migration-manager';
```

- [ ] **Step 3: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 4: Run all new tests**

Run: `npx vitest run src/shared/constants/ src/main/tools/file-watcher-cache.spec.ts src/main/core/startup-optimizer.spec.ts src/main/core/migration-manager.spec.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/index.ts src/main/core/index.ts
git commit -m "feat: export all new infrastructure modules"
```
