/**
 * Parallel Worktree Coordinator
 * Coordinates multiple subagents working in isolated git worktrees
 */

import { EventEmitter } from 'events';
import type {
  WorktreeSession,
  MergeStrategy,
  WorktreeMergeResult,
  ConflictDetail,
} from '../../shared/types/worktree.types';
import { WorktreeManager, getWorktreeManager } from '../workspace/git/worktree-manager';
import { getLogger } from '../logging/logger';
import { getErrorRecoveryManager } from '../core/error-recovery';
import { ErrorCategory } from '../../shared/types/error-recovery.types';

const logger = getLogger('ParallelWorktreeCoordinator');

export interface ParallelTask {
  id: string;
  description: string;
  files?: string[]; // Files this task will modify
  priority?: number;
  dependencies?: string[]; // Task IDs this depends on
}

export interface ParallelExecution {
  id: string;
  tasks: ParallelTask[];
  sessions: Map<string, WorktreeSession>;
  status: 'pending' | 'running' | 'merging' | 'completed' | 'failed';
  conflicts: ConflictDetail[];
  mergeOrder: string[];
  startTime: number;
  endTime?: number;
}

export interface CoordinatorConfig {
  maxParallelTasks: number;
  autoDetectConflicts: boolean;
  defaultMergeStrategy: MergeStrategy;
  cleanupOnComplete: boolean;
}

export class ParallelWorktreeCoordinator extends EventEmitter {
  private static instance: ParallelWorktreeCoordinator | null = null;
  private worktreeManager: WorktreeManager;
  private executions = new Map<string, ParallelExecution>();
  private config: CoordinatorConfig;

  private defaultConfig: CoordinatorConfig = {
    maxParallelTasks: 4,
    autoDetectConflicts: true,
    defaultMergeStrategy: 'auto',
    cleanupOnComplete: true,
  };

  static getInstance(): ParallelWorktreeCoordinator {
    if (!this.instance) {
      this.instance = new ParallelWorktreeCoordinator();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.worktreeManager = getWorktreeManager();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<CoordinatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Execution Management ============

  async startParallelExecution(
    tasks: ParallelTask[],
    instanceId: string,
    repoPath: string
  ): Promise<string> {
    const executionId = `parallel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Analyze task dependencies and detect potential conflicts
    const taskOrder = this.orderTasks(tasks);
    const conflictWarnings = this.config.autoDetectConflicts
      ? this.detectPotentialConflicts(tasks)
      : [];

    if (conflictWarnings.length > 0) {
      this.emit('execution:conflict-warning', { executionId, warnings: conflictWarnings });
    }

    const execution: ParallelExecution = {
      id: executionId,
      tasks: taskOrder,
      sessions: new Map(),
      status: 'pending',
      conflicts: [],
      mergeOrder: [],
      startTime: Date.now(),
    };

    this.executions.set(executionId, execution);
    this.emit('execution:created', { executionId, taskCount: tasks.length });

    // Create worktrees for each task
    await this.createWorktrees(execution, instanceId, repoPath);

    execution.status = 'running';
    this.emit('execution:started', { executionId });

    return executionId;
  }

  private orderTasks(tasks: ParallelTask[]): ParallelTask[] {
    // Topological sort based on dependencies
    const ordered: ParallelTask[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    const visit = (taskId: string) => {
      if (visited.has(taskId)) return;
      if (visiting.has(taskId)) {
        throw new Error(`Circular dependency detected involving task ${taskId}`);
      }

      visiting.add(taskId);
      const task = taskMap.get(taskId);

      if (task?.dependencies) {
        for (const depId of task.dependencies) {
          visit(depId);
        }
      }

      visiting.delete(taskId);
      visited.add(taskId);
      if (task) ordered.push(task);
    };

    for (const task of tasks) {
      visit(task.id);
    }

    return ordered;
  }

  private detectPotentialConflicts(tasks: ParallelTask[]): string[] {
    const warnings: string[] = [];
    const fileToTasks = new Map<string, string[]>();

    for (const task of tasks) {
      if (task.files) {
        for (const file of task.files) {
          const existing = fileToTasks.get(file) || [];
          if (existing.length > 0) {
            warnings.push(
              `File "${file}" may be modified by multiple tasks: ${[...existing, task.id].join(', ')}`
            );
          }
          existing.push(task.id);
          fileToTasks.set(file, existing);
        }
      }
    }

    return warnings;
  }

  private async createWorktrees(
    execution: ParallelExecution,
    instanceId: string,
    repoPath: string
  ): Promise<void> {
    const batchSize = this.config.maxParallelTasks;
    const batches: ParallelTask[][] = [];

    // Group tasks into batches
    for (let i = 0; i < execution.tasks.length; i += batchSize) {
      batches.push(execution.tasks.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      const promises = batch.map(async task => {
        const session = await this.worktreeManager.createWorktree(
          instanceId,
          task.description,
          {
            branchName: `task-${task.id}`,
            repoRoot: repoPath,
          }
        );
        execution.sessions.set(task.id, session);
        this.emit('worktree:created', { executionId: execution.id, taskId: task.id, session });
      });

      await Promise.all(promises);
    }
  }

  // ============ Task Completion ============

  async markTaskComplete(executionId: string, taskId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);

    const session = execution.sessions.get(taskId);
    if (!session) throw new Error(`Session for task ${taskId} not found`);

    await this.worktreeManager.completeWorktree(session.id);
    this.emit('task:completed', { executionId, taskId });

    // Check if all tasks are complete
    const allComplete = Array.from(execution.sessions.values()).every(
      s => s.status === 'completed' || s.status === 'merged'
    );

    if (allComplete) {
      await this.startMergeProcess(execution);
    }
  }

  // ============ Merge Process ============

  private async startMergeProcess(execution: ParallelExecution): Promise<void> {
    execution.status = 'merging';
    this.emit('execution:merging', { executionId: execution.id });

    // Determine optimal merge order
    execution.mergeOrder = this.determineMergeOrder(execution);

    // Detect actual conflicts
    execution.conflicts = await this.detectConflicts(execution);

    if (execution.conflicts.length > 0) {
      this.emit('execution:conflicts-detected', {
        executionId: execution.id,
        conflicts: execution.conflicts,
      });
      return; // Wait for user to resolve conflicts
    }

    // Auto-merge if no conflicts
    await this.performMerges(execution);
  }

  private determineMergeOrder(execution: ParallelExecution): string[] {
    // Order by: dependencies first, then by number of changes (fewer first)
    const sessions = Array.from(execution.sessions.entries());

    return sessions
      .sort((a, b) => {
        const taskA = execution.tasks.find(t => t.id === a[0]);
        const taskB = execution.tasks.find(t => t.id === b[0]);

        // Prioritize tasks with no dependencies
        const depsA = taskA?.dependencies?.length || 0;
        const depsB = taskB?.dependencies?.length || 0;
        if (depsA !== depsB) return depsA - depsB;

        // Then by change count (fewer changes first to minimize conflicts)
        const changesA = a[1].filesChanged?.length || 0;
        const changesB = b[1].filesChanged?.length || 0;
        return changesA - changesB;
      })
      .map(([taskId]) => taskId);
  }

  private async detectConflicts(execution: ParallelExecution): Promise<ConflictDetail[]> {
    const conflicts: ConflictDetail[] = [];

    for (const taskId of execution.mergeOrder) {
      const session = execution.sessions.get(taskId);
      if (!session) continue;

      // Use detectCrossWorktreeConflicts which returns CrossWorktreeConflict[]
      const detected = await this.worktreeManager.detectCrossWorktreeConflicts(
        session.id,
        session.filesChanged
      );
      // Map CrossWorktreeConflict to ConflictDetail
      for (const c of detected) {
        conflicts.push({
          file: c.file,
          conflictType: c.severity === 'high' ? 'content' : 'rename',
          ourChanges: `Changes in ${taskId}`,
          theirChanges: `Changes in ${c.worktrees.filter(w => w !== session.id).join(', ')}`,
          baseContent: '',
        });
      }
    }

    return conflicts;
  }

  private async performMerges(execution: ParallelExecution): Promise<void> {
    const results: WorktreeMergeResult[] = [];
    const failedMerges: string[] = [];

    for (const taskId of execution.mergeOrder) {
      const session = execution.sessions.get(taskId);
      if (!session) continue;

      try {
        const result = await this.worktreeManager.mergeWorktree(session.id, {
          strategy: this.config.defaultMergeStrategy,
        });
        results.push(result);
        this.emit('task:merged', { executionId: execution.id, taskId, result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const classified = getErrorRecoveryManager().classifyError(
          error instanceof Error ? error : new Error(message),
          `ParallelWorktreeCoordinator.performMerges[${taskId}]`
        );

        const isTransient =
          classified.category === ErrorCategory.TRANSIENT ||
          classified.category === ErrorCategory.NETWORK;

        if (isTransient) {
          logger.warn('Transient merge failure for task, continuing remaining merges', {
            executionId: execution.id,
            taskId,
            category: classified.category,
            error: message,
          });
        } else {
          logger.error(
            'Permanent merge failure for task, marking failed and continuing remaining merges',
            undefined,
            {
              executionId: execution.id,
              taskId,
              category: classified.category,
              recoverable: classified.recoverable,
              error: message,
            }
          );
        }

        this.emit('task:merge-failed', {
          executionId: execution.id,
          taskId,
          error: message,
          category: classified.category,
          recoverable: classified.recoverable,
        });
        failedMerges.push(taskId);
        // Continue with remaining merges instead of halting
      }
    }

    if (failedMerges.length > 0) {
      execution.status = 'failed';
      this.emit('execution:partial-failure', {
        executionId: execution.id,
        failedMerges,
        successfulMerges: execution.mergeOrder.filter(id => !failedMerges.includes(id)),
      });
    }

    // Cleanup worktrees if configured
    if (this.config.cleanupOnComplete) {
      await this.cleanup(execution);
    }

    if (failedMerges.length === 0) {
      execution.status = 'completed';
      execution.endTime = Date.now();
      this.emit('execution:completed', {
        executionId: execution.id,
        duration: execution.endTime - execution.startTime,
      });
    }
  }

  // ============ Manual Conflict Resolution ============

  async resolveConflict(
    executionId: string,
    taskId: string,
    resolution: 'ours' | 'theirs' | 'manual'
  ): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);

    // Mark conflict as resolved
    execution.conflicts = execution.conflicts.filter(
      c => !(c.file && execution.sessions.get(taskId)?.filesChanged?.includes(c.file))
    );

    this.emit('conflict:resolved', { executionId, taskId, resolution });

    // If all conflicts resolved, continue with merges
    if (execution.conflicts.length === 0) {
      await this.performMerges(execution);
    }
  }

  // ============ Cleanup ============

  private async cleanup(execution: ParallelExecution): Promise<void> {
    const failures: { taskId: string; error: string }[] = [];

    for (const [taskId, session] of execution.sessions) {
      try {
        await this.worktreeManager.abandonWorktree(session.id);
        this.emit('worktree:cleaned', { executionId: execution.id, taskId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Failed to clean up worktree', {
          executionId: execution.id,
          taskId,
          sessionId: session.id,
          error: message,
        });
        failures.push({ taskId, error: message });
      }
    }

    if (failures.length > 0) {
      this.emit('worktree:cleanup-partial', {
        executionId: execution.id,
        failedCount: failures.length,
        totalCount: execution.sessions.size,
        failures,
      });
    }
  }

  async cancelExecution(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Execution ${executionId} not found`);

    await this.cleanup(execution);
    execution.status = 'failed';
    this.emit('execution:cancelled', { executionId });
  }

  // ============ Query Methods ============

  getExecution(executionId: string): ParallelExecution | undefined {
    return this.executions.get(executionId);
  }

  getActiveExecutions(): ParallelExecution[] {
    return Array.from(this.executions.values()).filter(
      e => e.status === 'running' || e.status === 'merging'
    );
  }

  getTaskSession(executionId: string, taskId: string): WorktreeSession | undefined {
    return this.executions.get(executionId)?.sessions.get(taskId);
  }
}

// Export singleton getter
export function getParallelWorktreeCoordinator(): ParallelWorktreeCoordinator {
  return ParallelWorktreeCoordinator.getInstance();
}
