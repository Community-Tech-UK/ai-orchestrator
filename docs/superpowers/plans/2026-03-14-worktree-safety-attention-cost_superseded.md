# Worktree Lifecycle Safety, Attention Priority Queue & Cost Aggregation

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): SUPERSEDED.** Chunk 1 (auto-merge hooks on child exit) is obsolete: generic child agents never run in worktrees, and the worktree owners that do exist each integrate and clean up their own (`loop-worktree-lifecycle.ts` `finalizeLoopWorktree`, boot-time `reconcileManagedWorktreeLifecycles`/`reconcileOrphanedWorktrees`, `GitWriteQueue` in place of the merge mutex). Age-based reaping was rejected on purpose (`worktree-manager.ts` header). Chunk 2 was superseded by the project-rail redesign (`project-rail-builder.service.ts` ordering plus per-row attention highlighting). Chunk 3 targets `ParallelWorktreeCoordinator`, which spawns no agents and has no UI caller; whether to delete or finish that coordinator is recorded as a product decision in the sweep plan. A separate campaign worktree cleanup gap found during the audit is recorded there too.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make parallel worktree agents trustworthy — auto-merge on completion, prevent orphans, surface which agents need attention, and track parallel execution costs.

**Architecture:** Three independent subsystems that share minimal surface area. (1) Worktree lifecycle hooks integrated into the existing `handleChildExit()` flow in InstanceManager. (2) Attention-priority sorting added to the existing `projectGroups` computed signal in InstanceListComponent. (3) Cost aggregation computed from existing per-instance `ContextUsage` data, rolled up per `ParallelExecution`.

**Tech Stack:** TypeScript, Angular 21 signals, Electron IPC, Vitest

---

## File Map

### Subsystem 1: Worktree Lifecycle Safety & Auto-Merge

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/workspace/git/worktree-lifecycle-hooks.ts` | Bridges child exit → worktree complete → auto-merge. Reaper timer for orphans. |
| Modify | `src/main/instance/instance-manager.ts:872-996` | Call worktree lifecycle hook in `handleChildExit()` |
| Modify | `src/shared/types/worktree.types.ts` | Add `childInstanceId` tracking, `autoMerge` config field |
| Modify | `src/main/workspace/git/worktree-manager.ts` | Add `getSessionByChildId()` query, stale reaper improvements |
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | Auto-complete + merge when all tasks finish via lifecycle hooks |
| Create | `src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts` | Tests |

### Subsystem 2: Attention Priority Queue

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/renderer/app/features/instance-list/instance-list.component.ts:1455-1475` | Sort projects by attention tone priority before recency |
| Modify | `src/renderer/app/features/instance-list/instance-list.component.ts:2025-2054` | Add `waitingSince` timestamp to attention state, expose in `ProjectGroup` |

### Subsystem 3: Per-Execution Cost Aggregation

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | Track cumulative tokens/cost per execution |
| Modify | `src/shared/types/worktree.types.ts` | Add `ExecutionCostSummary` type |
| Modify | `src/main/ipc/handlers/parallel-worktree-handlers.ts` | Return cost data in GET_RESULTS response |

---

## Critical Amendments (Self-Review)

Three issues identified during self-review that are integrated into the tasks below:

### Amendment 1: Merge Mutex
Concurrent auto-merges from multiple child exits would corrupt git. The `onChildExit()` path in `WorktreeLifecycleHooks` must serialize merge operations through a promise queue. This prevents two worktrees trying to `git merge` into `main` simultaneously.

### Amendment 2: Aggressive Empty-Worktree Cleanup
Don't wait `maxAgeHours` (48h default) for worktrees with zero commits whose child is dead. In `reapOrphanedWorktrees()`, if a worktree has no commits AND its child instance is no longer alive, clean it up immediately regardless of age.

### Amendment 3: Wire `updateTaskCost()` to Instance Events
Task 6 adds `updateTaskCost()` but nothing calls it. A new Task 6b wires `instance:batch-update` events to feed token usage into the cost tracker.

---

## Chunk 1: Worktree Lifecycle Safety & Auto-Merge

### Task 1: Add `autoMerge` config and `childInstanceId` tracking to types

**Files:**
- Modify: `src/shared/types/worktree.types.ts`

- [ ] **Step 1: Add `autoMerge` field to `WorktreeConfig` and ensure `childInstanceId` is always populated**

In `src/shared/types/worktree.types.ts`, add to `WorktreeConfig`:

```typescript
// In WorktreeConfig interface, after maxAgeHours:
autoMergeOnComplete: boolean;  // Auto-merge worktree when child agent completes
autoMergeStrategy: MergeStrategy;  // Strategy used for auto-merge (default: 'squash')
```

Update `createDefaultWorktreeConfig()`:

```typescript
autoMergeOnComplete: true,
autoMergeStrategy: 'squash',
```

- [ ] **Step 2: Add `ExecutionCostSummary` type** (used later in Task 6)

```typescript
export interface ExecutionCostSummary {
  totalTokensUsed: number;
  totalRequestCount: number;
  perTaskTokens: Map<string, number>;
  estimatedCost?: number;
}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (types only, no breaking changes)

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/worktree.types.ts
git commit -m "feat(worktree): add autoMerge config and ExecutionCostSummary type"
```

---

### Task 2: Add `getSessionByChildId()` query to WorktreeManager

**Files:**
- Modify: `src/main/workspace/git/worktree-manager.ts`

- [ ] **Step 1: Add lookup method**

In `WorktreeManager`, in the `// ============ Queries ============` section (after `getAllSessions()`), add:

```typescript
getSessionByChildId(childInstanceId: string): WorktreeSession | undefined {
  return Array.from(this.sessions.values()).find(
    s => s.childInstanceId === childInstanceId
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/workspace/git/worktree-manager.ts
git commit -m "feat(worktree): add getSessionByChildId query"
```

---

### Task 3: Create worktree lifecycle hooks

This is the core new file. It bridges child exit → worktree completion → auto-merge, and runs a periodic reaper for orphaned worktrees.

**Files:**
- Create: `src/main/workspace/git/worktree-lifecycle-hooks.ts`
- Create: `src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorktreeLifecycleHooks } from '../worktree-lifecycle-hooks';
import type { WorktreeSession, WorktreeConfig } from '../../../../shared/types/worktree.types';
import { createDefaultWorktreeConfig } from '../../../../shared/types/worktree.types';

// Mock WorktreeManager
const mockWorktreeManager = {
  getSessionByChildId: vi.fn(),
  completeWorktree: vi.fn(),
  mergeWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  getActiveSessions: vi.fn(() => []),
  getAllSessions: vi.fn(() => []),
  getConfig: vi.fn(() => createDefaultWorktreeConfig()),
  abandonWorktree: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
};

vi.mock('../worktree-manager', () => ({
  getWorktreeManager: () => mockWorktreeManager,
}));

describe('WorktreeLifecycleHooks', () => {
  let hooks: WorktreeLifecycleHooks;

  beforeEach(() => {
    WorktreeLifecycleHooks._resetForTesting();
    vi.clearAllMocks();
    hooks = WorktreeLifecycleHooks.getInstance();
  });

  afterEach(() => {
    hooks.destroy();
  });

  describe('onChildExit', () => {
    it('should complete and auto-merge worktree when child exits successfully', async () => {
      const session: WorktreeSession = {
        id: 'wt-1',
        instanceId: 'parent-1',
        childInstanceId: 'child-1',
        worktreePath: '/tmp/wt',
        branchName: 'task-fix-auth',
        baseBranch: 'main',
        baseCommit: 'abc123',
        status: 'active',
        lastActivity: Date.now(),
        commits: [{ hash: 'def456', message: 'fix auth', author: 'agent', timestamp: Date.now(), filesChanged: ['auth.ts'] }],
        filesChanged: ['auth.ts'],
        additions: 10,
        deletions: 2,
        createdAt: Date.now(),
        taskDescription: 'Fix auth',
        taskType: 'bugfix',
      };
      mockWorktreeManager.getSessionByChildId.mockReturnValue(session);
      mockWorktreeManager.completeWorktree.mockResolvedValue({ ...session, status: 'completed' });
      mockWorktreeManager.mergeWorktree.mockResolvedValue({ success: true, worktreeId: 'wt-1', mergeCommit: 'abc' });

      await hooks.onChildExit('child-1', 0);

      expect(mockWorktreeManager.getSessionByChildId).toHaveBeenCalledWith('child-1');
      expect(mockWorktreeManager.completeWorktree).toHaveBeenCalledWith('wt-1');
      expect(mockWorktreeManager.mergeWorktree).toHaveBeenCalledWith('wt-1', { strategy: 'squash' });
    });

    it('should skip merge if child has no worktree', async () => {
      mockWorktreeManager.getSessionByChildId.mockReturnValue(undefined);

      await hooks.onChildExit('child-no-wt', 0);

      expect(mockWorktreeManager.completeWorktree).not.toHaveBeenCalled();
    });

    it('should complete but NOT merge if worktree has no commits', async () => {
      const session: WorktreeSession = {
        id: 'wt-2',
        instanceId: 'parent-1',
        childInstanceId: 'child-2',
        worktreePath: '/tmp/wt2',
        branchName: 'task-empty',
        baseBranch: 'main',
        baseCommit: 'abc123',
        status: 'active',
        lastActivity: Date.now(),
        commits: [],
        filesChanged: [],
        additions: 0,
        deletions: 0,
        createdAt: Date.now(),
        taskDescription: 'Empty task',
        taskType: 'feature',
      };
      mockWorktreeManager.getSessionByChildId.mockReturnValue(session);
      mockWorktreeManager.completeWorktree.mockResolvedValue({ ...session, status: 'completed', commits: [], filesChanged: [] });

      await hooks.onChildExit('child-2', 0);

      expect(mockWorktreeManager.completeWorktree).toHaveBeenCalledWith('wt-2');
      expect(mockWorktreeManager.mergeWorktree).not.toHaveBeenCalled();
      // Should cleanup empty worktree automatically
      expect(mockWorktreeManager.cleanupWorktree).toHaveBeenCalledWith('wt-2');
    });

    it('should complete but NOT auto-merge if child exited with error', async () => {
      const session: WorktreeSession = {
        id: 'wt-3',
        instanceId: 'parent-1',
        childInstanceId: 'child-3',
        worktreePath: '/tmp/wt3',
        branchName: 'task-failed',
        baseBranch: 'main',
        baseCommit: 'abc123',
        status: 'active',
        lastActivity: Date.now(),
        commits: [{ hash: 'aaa', message: 'wip', author: 'agent', timestamp: Date.now(), filesChanged: ['x.ts'] }],
        filesChanged: ['x.ts'],
        additions: 5,
        deletions: 0,
        createdAt: Date.now(),
        taskDescription: 'Failed task',
        taskType: 'feature',
      };
      mockWorktreeManager.getSessionByChildId.mockReturnValue(session);
      mockWorktreeManager.completeWorktree.mockResolvedValue({ ...session, status: 'completed' });

      await hooks.onChildExit('child-3', 1); // non-zero exit

      expect(mockWorktreeManager.completeWorktree).toHaveBeenCalledWith('wt-3');
      expect(mockWorktreeManager.mergeWorktree).not.toHaveBeenCalled();
    });
  });

    it('should serialize concurrent merges via queue (Amendment 1)', async () => {
      const order: string[] = [];
      const session1: WorktreeSession = {
        id: 'wt-q1', instanceId: 'p', childInstanceId: 'c1',
        worktreePath: '/tmp/q1', branchName: 'b1', baseBranch: 'main', baseCommit: 'a',
        status: 'active', lastActivity: Date.now(),
        commits: [{ hash: 'h1', message: 'm', author: 'a', timestamp: Date.now(), filesChanged: ['f'] }],
        filesChanged: ['f'], additions: 1, deletions: 0, createdAt: Date.now(),
        taskDescription: 't1', taskType: 'feature',
      };
      const session2 = { ...session1, id: 'wt-q2', childInstanceId: 'c2' };

      mockWorktreeManager.getSessionByChildId.mockImplementation((id: string) =>
        id === 'c1' ? session1 : id === 'c2' ? session2 : undefined
      );
      mockWorktreeManager.completeWorktree.mockImplementation(async (id: string) => ({
        ...(id === 'wt-q1' ? session1 : session2), status: 'completed',
      }));
      mockWorktreeManager.mergeWorktree.mockImplementation(async (id: string) => {
        order.push(`start-${id}`);
        await new Promise(r => setTimeout(r, 10));
        order.push(`end-${id}`);
        return { success: true, worktreeId: id, mergeCommit: 'mc' };
      });

      // Fire both exits concurrently
      await Promise.all([
        hooks.onChildExit('c1', 0),
        hooks.onChildExit('c2', 0),
      ]);

      // Merges must be serialized: start-end-start-end, NOT interleaved
      expect(order[0]).toBe('start-wt-q1');
      expect(order[1]).toBe('end-wt-q1');
      expect(order[2]).toBe('start-wt-q2');
      expect(order[3]).toBe('end-wt-q2');
    });
  });

  describe('reapOrphanedWorktrees', () => {
    it('should immediately cleanup empty worktrees with dead children (Amendment 2)', async () => {
      const emptySession: WorktreeSession = {
        id: 'wt-empty', instanceId: 'p', childInstanceId: 'dead-child',
        worktreePath: '/tmp/empty', branchName: 'b', baseBranch: 'main', baseCommit: 'a',
        status: 'active', lastActivity: Date.now(), // Just created — not old!
        commits: [], filesChanged: [], additions: 0, deletions: 0,
        createdAt: Date.now(), taskDescription: 't', taskType: 'feature',
      };
      mockWorktreeManager.getAllSessions.mockReturnValue([emptySession]);

      await hooks.reapOrphanedWorktrees(() => false); // child is dead

      expect(mockWorktreeManager.cleanupWorktree).toHaveBeenCalledWith('wt-empty');
    });

    it('should abandon worktrees older than maxAgeHours with no active child', async () => {
      const staleSession: WorktreeSession = {
        id: 'wt-stale',
        instanceId: 'parent-gone',
        childInstanceId: 'child-gone',
        worktreePath: '/tmp/wt-stale',
        branchName: 'task-old',
        baseBranch: 'main',
        baseCommit: 'abc',
        status: 'active',
        lastActivity: Date.now() - 72 * 60 * 60 * 1000, // 72 hours ago
        commits: [],
        filesChanged: [],
        additions: 0,
        deletions: 0,
        createdAt: Date.now() - 72 * 60 * 60 * 1000,
        taskDescription: 'Old task',
        taskType: 'feature',
      };
      mockWorktreeManager.getAllSessions.mockReturnValue([staleSession]);

      await hooks.reapOrphanedWorktrees(() => false); // isInstanceAlive returns false

      expect(mockWorktreeManager.abandonWorktree).toHaveBeenCalledWith('wt-stale', expect.stringContaining('orphan'));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `src/main/workspace/git/worktree-lifecycle-hooks.ts`:

```typescript
/**
 * Worktree Lifecycle Hooks
 *
 * Bridges child instance exit → worktree completion → auto-merge.
 * Also runs periodic reaper for orphaned worktrees.
 */

import { getWorktreeManager } from './worktree-manager';
import { getLogger } from '../../logging/logger';

const logger = getLogger('WorktreeLifecycleHooks');

export class WorktreeLifecycleHooks {
  private static instance: WorktreeLifecycleHooks | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  /** Serializes merge operations to prevent concurrent git corruption (Amendment 1) */
  private mergeQueue: Promise<void> = Promise.resolve();

  static getInstance(): WorktreeLifecycleHooks {
    if (!this.instance) {
      this.instance = new WorktreeLifecycleHooks();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.destroy();
    }
    this.instance = null;
  }

  private constructor() {}

  /**
   * Called when a child instance exits. If it was using a worktree:
   * 1. Complete the worktree (capture stats)
   * 2. If successful exit + has commits + autoMerge enabled → merge
   * 3. If no commits → cleanup automatically (no orphan)
   * 4. If error exit → leave worktree as 'completed' for manual review
   */
  async onChildExit(childInstanceId: string, exitCode: number | null): Promise<void> {
    const manager = getWorktreeManager();
    const session = manager.getSessionByChildId(childInstanceId);

    if (!session) return; // Child wasn't using a worktree
    if (session.status !== 'active' && session.status !== 'installing') return;

    logger.info('Child exited, processing worktree', {
      childInstanceId,
      worktreeId: session.id,
      exitCode,
    });

    try {
      // 1. Complete the worktree (captures commit stats)
      const completed = await manager.completeWorktree(session.id);

      // 2. No changes? Clean up immediately — don't leave empty orphans
      if (completed.commits.length === 0 && completed.filesChanged.length === 0) {
        logger.info('Worktree has no changes, cleaning up', { worktreeId: session.id });
        await manager.cleanupWorktree(session.id);
        return;
      }

      // 3. Error exit? Leave as 'completed' for manual review, don't auto-merge
      const success = exitCode === 0 || exitCode === null;
      if (!success) {
        logger.warn('Child exited with error, worktree left for manual review', {
          worktreeId: session.id,
          exitCode,
        });
        return;
      }

      // 4. Auto-merge if configured (serialized via merge queue — Amendment 1)
      const config = manager.getConfig();
      if (config.autoMergeOnComplete) {
        await this.enqueueMerge(async () => {
          logger.info('Auto-merging worktree', {
            worktreeId: session.id,
            strategy: config.autoMergeStrategy,
          });

          const result = await manager.mergeWorktree(session.id, {
            strategy: config.autoMergeStrategy,
          });

          if (result.success) {
            logger.info('Worktree auto-merged successfully', {
              worktreeId: session.id,
              mergeCommit: result.mergeCommit,
            });
          } else {
            logger.warn('Worktree auto-merge failed, left for manual resolution', {
              worktreeId: session.id,
              error: result.error,
              conflictFiles: result.manualResolutionRequired,
            });
          }
        });
      }
    } catch (error) {
      logger.error(
        'Error processing worktree lifecycle on child exit',
        error instanceof Error ? error : undefined,
        { childInstanceId, worktreeId: session.id }
      );
    }
  }

  /**
   * Serialize merge operations through a promise queue (Amendment 1).
   * Prevents concurrent git merge corruption when multiple children exit simultaneously.
   */
  private async enqueueMerge(fn: () => Promise<void>): Promise<void> {
    const prev = this.mergeQueue;
    this.mergeQueue = prev.then(fn, fn); // Run even if previous merge failed
    await this.mergeQueue;
  }

  /**
   * Reap orphaned worktrees — those whose child instance no longer exists
   * and that have exceeded maxAgeHours.
   *
   * @param isInstanceAlive - callback to check if an instance ID still exists
   */
  async reapOrphanedWorktrees(
    isInstanceAlive: (instanceId: string) => boolean
  ): Promise<number> {
    const manager = getWorktreeManager();
    const config = manager.getConfig();
    const maxAgeMs = config.maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();
    let reaped = 0;

    for (const session of manager.getAllSessions()) {
      // Only reap active/completed sessions
      if (!['active', 'completed', 'installing'].includes(session.status)) continue;

      const age = now - session.lastActivity;

      // Check: is the owning child instance still alive?
      const childAlive = session.childInstanceId
        ? isInstanceAlive(session.childInstanceId)
        : false;

      // Amendment 2: Aggressively clean empty worktrees with dead children (no age check)
      const isEmpty = session.commits.length === 0 && session.filesChanged.length === 0;
      if (!childAlive && isEmpty) {
        logger.info('Cleaning empty orphaned worktree immediately', {
          worktreeId: session.id,
          childInstanceId: session.childInstanceId,
        });
        try {
          await manager.cleanupWorktree(session.id);
          reaped++;
        } catch (error) {
          logger.error('Failed to clean empty orphan', error instanceof Error ? error : undefined, {
            worktreeId: session.id,
          });
        }
        continue;
      }

      // Reap if: child is dead AND worktree is older than maxAge
      if (!childAlive && age > maxAgeMs) {
        logger.warn('Reaping orphaned worktree', {
          worktreeId: session.id,
          childInstanceId: session.childInstanceId,
          ageHours: Math.round(age / (60 * 60 * 1000)),
        });

        try {
          await manager.abandonWorktree(
            session.id,
            `orphan reaper: child ${session.childInstanceId} no longer exists, age ${Math.round(age / 3600000)}h`
          );
          reaped++;
        } catch (error) {
          logger.error('Failed to reap orphaned worktree', error instanceof Error ? error : undefined, {
            worktreeId: session.id,
          });
        }
      }
    }

    if (reaped > 0) {
      logger.info('Orphan reaper completed', { reaped });
    }

    return reaped;
  }

  /**
   * Start periodic orphan reaper. Runs every 30 minutes.
   */
  startReaper(isInstanceAlive: (instanceId: string) => boolean): void {
    if (this.reaperTimer) return;

    this.reaperTimer = setInterval(async () => {
      try {
        await this.reapOrphanedWorktrees(isInstanceAlive);
      } catch (error) {
        logger.error('Orphan reaper error', error instanceof Error ? error : undefined);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  destroy(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }
}

export function getWorktreeLifecycleHooks(): WorktreeLifecycleHooks {
  return WorktreeLifecycleHooks.getInstance();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/workspace/git/worktree-lifecycle-hooks.ts src/main/workspace/git/__tests__/worktree-lifecycle-hooks.spec.ts
git commit -m "feat(worktree): add lifecycle hooks for auto-merge and orphan reaping"
```

---

### Task 4: Wire lifecycle hooks into `handleChildExit()`

**Files:**
- Modify: `src/main/instance/instance-manager.ts:872-996`

- [ ] **Step 1: Add import at top of file**

Add to the imports in `instance-manager.ts`:

```typescript
import { getWorktreeLifecycleHooks } from '../workspace/git/worktree-lifecycle-hooks';
```

- [ ] **Step 2: Call lifecycle hook in `handleChildExit()`**

In `handleChildExit()`, after step 4 (clean up tasks, line ~944) and before step 5 (notify parent CLI), add:

```typescript
    // 4b. Process worktree lifecycle (auto-merge if applicable)
    try {
      await getWorktreeLifecycleHooks().onChildExit(childId, exitCode);
    } catch (err) {
      logger.error('Worktree lifecycle hook failed', err instanceof Error ? err : undefined, { childId });
    }
```

- [ ] **Step 3: Start reaper in constructor or init**

In the `InstanceManager` constructor (or `init()` if one exists), after existing initialization, add:

```typescript
    // Start worktree orphan reaper
    getWorktreeLifecycleHooks().startReaper(
      (instanceId: string) => this.state.getInstance(instanceId) !== undefined
    );
```

- [ ] **Step 4: Clean up reaper in `destroy()`**

In `destroy()`, add before existing cleanup:

```typescript
    getWorktreeLifecycleHooks().destroy();
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run full test suite for instance-manager**

Run: `npx vitest run src/main/instance/`
Expected: PASS (existing tests shouldn't break — the hook is a no-op when no worktree exists)

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-manager.ts
git commit -m "feat(worktree): wire auto-merge and orphan reaper into child exit flow"
```

---

## Chunk 2: Attention Priority Queue

### Task 5: Sort project groups by attention priority

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-list.component.ts`

- [ ] **Step 1: Add tone priority map**

Near the top of the `InstanceListComponent` class (around the other private properties), add:

```typescript
  /** Attention-priority ordering for project groups */
  private readonly tonePriority: Record<string, number> = {
    attention: 0,   // Errors + waiting_for_input — always on top
    working: 1,     // Active work — second tier
    connecting: 2,  // Initializing — third
    ready: 3,       // Idle but alive
    history: 4,     // No live instances
  };
```

- [ ] **Step 2: Add `waitingSince` to `ProjectGroup` interface**

In the `ProjectGroup` interface (within the same file), add:

```typescript
  /** Timestamp of earliest waiting_for_input instance (for sorting within attention tier) */
  waitingSince: number | null;
```

- [ ] **Step 3: Compute `waitingSince` in `getProjectStateSummary()`**

Modify `getProjectStateSummary()` (lines 2025-2054) — change the return type to include `waitingSince` and compute it:

```typescript
  private getProjectStateSummary(
    liveItems: HierarchicalInstance[],
    historyItems: ConversationHistoryEntry[],
    hasDraft: boolean
  ): Pick<ProjectGroup, 'projectStateLabel' | 'projectStateTone' | 'waitingSince'> {
    const statuses = new Set(liveItems.map((item) => item.instance.status));

    // Compute earliest waiting timestamp
    let waitingSince: number | null = null;
    if (statuses.has('waiting_for_input') || statuses.has('error')) {
      const waitingInstances = liveItems.filter(
        item => item.instance.status === 'waiting_for_input' || item.instance.status === 'error'
      );
      if (waitingInstances.length > 0) {
        waitingSince = Math.min(...waitingInstances.map(item => item.instance.lastActivity));
      }
    }

    if (statuses.has('error')) {
      return { projectStateLabel: 'Issue', projectStateTone: 'attention', waitingSince };
    }
    if (statuses.has('waiting_for_input')) {
      return { projectStateLabel: 'Awaiting input', projectStateTone: 'attention', waitingSince };
    }
    if (statuses.has('busy')) {
      return { projectStateLabel: 'Working', projectStateTone: 'working', waitingSince: null };
    }
    if (statuses.has('initializing') || statuses.has('respawning')) {
      return { projectStateLabel: 'Connecting', projectStateTone: 'connecting', waitingSince: null };
    }
    if (liveItems.length > 0) {
      return { projectStateLabel: 'Ready', projectStateTone: 'ready', waitingSince: null };
    }
    if (hasDraft) {
      return { projectStateLabel: 'Draft ready', projectStateTone: 'ready', waitingSince: null };
    }
    if (historyItems.length > 0) {
      return { projectStateLabel: 'Recent history', projectStateTone: 'history', waitingSince: null };
    }
    return { projectStateLabel: 'Available', projectStateTone: 'history', waitingSince: null };
  }
```

- [ ] **Step 4: Update sort comparator in `projectGroups` computed signal**

Replace the sort function at lines 1455-1475 with:

```typescript
    return Array.from(groups.values()).sort((left, right) => {
      // Primary: attention-needing projects bubble to top
      const leftTone = this.tonePriority[left.projectStateTone] ?? 99;
      const rightTone = this.tonePriority[right.projectStateTone] ?? 99;
      if (leftTone !== rightTone) return leftTone - rightTone;

      // Within 'attention' tier: longest-waiting first
      if (left.projectStateTone === 'attention' && right.projectStateTone === 'attention') {
        const leftWait = left.waitingSince ?? Infinity;
        const rightWait = right.waitingSince ?? Infinity;
        if (leftWait !== rightWait) return leftWait - rightWait; // earlier = higher priority
      }

      // Secondary: respect pinned/recent directory order
      const leftOrder = recentDirectoryOrder.get(left.key);
      const rightOrder = recentDirectoryOrder.get(right.key);
      if (leftOrder !== undefined && rightOrder !== undefined) {
        return leftOrder - rightOrder;
      }
      if (leftOrder !== undefined) return -1;
      if (rightOrder !== undefined) return 1;

      // Tertiary: most recent activity first
      const timestampDelta =
        this.getProjectSortTimestamp(right) - this.getProjectSortTimestamp(left);
      if (timestampDelta !== 0) return timestampDelta;

      return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    });
```

- [ ] **Step 5: Update all call sites that spread `getProjectStateSummary()`**

Search for all places where `getProjectStateSummary()` is called and ensure they also initialize `waitingSince`. The function returns it now, but any inline `ProjectGroup` construction that doesn't call the function needs a default:

```typescript
waitingSince: null,
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Run lint**

Run: `npx eslint src/renderer/app/features/instance-list/instance-list.component.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/renderer/app/features/instance-list/instance-list.component.ts
git commit -m "feat(ui): sort project list by attention priority — waiting/error projects bubble to top"
```

---

## Chunk 3: Per-Execution Cost Aggregation

### Task 6: Track and expose cost data per parallel execution

**Files:**
- Modify: `src/main/orchestration/parallel-worktree-coordinator.ts`
- Modify: `src/main/ipc/handlers/parallel-worktree-handlers.ts`

- [ ] **Step 1: Add cost tracking to `ParallelExecution`**

In `parallel-worktree-coordinator.ts`, modify the `ParallelExecution` interface:

```typescript
export interface ParallelExecution {
  id: string;
  tasks: ParallelTask[];
  sessions: Map<string, WorktreeSession>;
  status: 'pending' | 'running' | 'merging' | 'completed' | 'failed';
  conflicts: ConflictDetail[];
  mergeOrder: string[];
  startTime: number;
  endTime?: number;

  // Cost tracking
  totalTokensUsed: number;
  totalRequestCount: number;
  perTaskTokens: Map<string, number>;
}
```

Update `startParallelExecution()` to initialize the new fields:

```typescript
    const execution: ParallelExecution = {
      // ... existing fields ...
      totalTokensUsed: 0,
      totalRequestCount: 0,
      perTaskTokens: new Map(),
    };
```

- [ ] **Step 2: Add method to update cost data**

Add to `ParallelWorktreeCoordinator`:

```typescript
  /**
   * Update cost tracking for a task in a parallel execution.
   * Called externally when instance token usage updates are received.
   */
  updateTaskCost(executionId: string, taskId: string, tokensUsed: number, requestCount: number): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;

    const previousTokens = execution.perTaskTokens.get(taskId) ?? 0;
    const tokenDelta = tokensUsed - previousTokens;

    execution.perTaskTokens.set(taskId, tokensUsed);
    execution.totalTokensUsed += tokenDelta;
    execution.totalRequestCount += requestCount;
  }

  /**
   * Get cost summary for a parallel execution.
   */
  getCostSummary(executionId: string): { totalTokensUsed: number; totalRequestCount: number; perTaskTokens: Record<string, number> } | undefined {
    const execution = this.executions.get(executionId);
    if (!execution) return undefined;

    return {
      totalTokensUsed: execution.totalTokensUsed,
      totalRequestCount: execution.totalRequestCount,
      perTaskTokens: Object.fromEntries(execution.perTaskTokens),
    };
  }
```

- [ ] **Step 3: Include cost data in IPC results handler**

In `src/main/ipc/handlers/parallel-worktree-handlers.ts`, in the `PARALLEL_WORKTREE_GET_RESULTS` handler, add cost data to the response:

```typescript
        const costSummary = coordinator.getCostSummary(validated.executionId);
        return {
          success: true,
          data: {
            // ... existing fields ...
            costSummary,
          }
        };
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run lint on modified files**

Run: `npx eslint src/main/orchestration/parallel-worktree-coordinator.ts src/main/ipc/handlers/parallel-worktree-handlers.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/orchestration/parallel-worktree-coordinator.ts src/main/ipc/handlers/parallel-worktree-handlers.ts
git commit -m "feat(worktree): add per-execution cost aggregation for parallel tasks"
```

---

### Task 6b: Wire `updateTaskCost()` to instance batch-update events (Amendment 3)

**Files:**
- Modify: `src/main/orchestration/parallel-worktree-coordinator.ts`

The `updateTaskCost()` method exists but nothing calls it. We need to listen for `instance:batch-update` events and feed token usage into cost tracking for any instance that belongs to a parallel execution.

- [ ] **Step 1: Add method to find execution by child instance ID**

In `ParallelWorktreeCoordinator`, add a lookup:

```typescript
  /**
   * Find the execution containing a task with the given child instance ID.
   */
  private findExecutionByChildId(childInstanceId: string): { execution: ParallelExecution; task: ParallelTask } | undefined {
    for (const execution of this.executions.values()) {
      const task = execution.tasks.find(t => t.childInstanceId === childInstanceId);
      if (task) return { execution, task };
    }
    return undefined;
  }
```

- [ ] **Step 2: Add event listener for `instance:batch-update`**

In the `ParallelWorktreeCoordinator` constructor (or `init()` method), subscribe to instance batch updates:

```typescript
    // Wire cost tracking to instance updates (Amendment 3)
    const instanceManager = getInstanceManager();
    instanceManager.on('instance:batch-update', (data: { updates: Array<{ instanceId: string; contextUsage?: { used: number; total: number } }> }) => {
      for (const update of data.updates) {
        if (!update.contextUsage) continue;
        const match = this.findExecutionByChildId(update.instanceId);
        if (match) {
          this.updateTaskCost(
            match.execution.id,
            match.task.id,
            update.contextUsage.used,
            0 // requestCount not available in batch-update, tracked separately
          );
        }
      }
    });
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/orchestration/parallel-worktree-coordinator.ts
git commit -m "feat(worktree): wire updateTaskCost to instance batch-update events"
```

---

## Integration Verification

### Task 7: Full integration check

- [ ] **Step 1: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS on both

- [ ] **Step 2: Run full lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Run all tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: Verify import chain**

Check that the new `worktree-lifecycle-hooks.ts` is imported from `instance-manager.ts` and the reaper is started. Verify no circular imports.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration fixes for worktree lifecycle and attention priority"
```
