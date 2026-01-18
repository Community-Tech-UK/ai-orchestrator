/**
 * Task Manager - Tracks subagent task execution and results
 */

import {
  TaskExecution,
  TaskStatus,
  TaskResult,
  TaskProgress,
  TaskError,
  TaskHistory,
  createTaskExecution,
  TaskPriority,
  QueuedTask,
} from '../../shared/types/task.types';

/**
 * Task manager for tracking subagent tasks
 */
export class TaskManager {
  /** Active tasks by task ID */
  private tasks: Map<string, TaskExecution> = new Map();

  /** Tasks by child ID (for quick lookup) */
  private tasksByChild: Map<string, string> = new Map();

  /** Tasks by parent ID */
  private tasksByParent: Map<string, string[]> = new Map();

  /** Completed/failed tasks (for history) */
  private completedTasks: TaskExecution[] = [];

  /** Task queue for when max children is reached */
  private taskQueue: QueuedTask[] = [];

  /** Max completed tasks to keep in history */
  private maxHistorySize = 100;

  /**
   * Create and register a new task
   */
  createTask(
    parentId: string,
    childId: string,
    task: string,
    options?: {
      name?: string;
      priority?: TaskPriority;
      timeout?: number;
      workingDirectory?: string;
    }
  ): TaskExecution {
    const execution = createTaskExecution(parentId, childId, task, options);

    // Register the task
    this.tasks.set(execution.taskId, execution);
    this.tasksByChild.set(childId, execution.taskId);

    // Add to parent's task list
    const parentTasks = this.tasksByParent.get(parentId) || [];
    parentTasks.push(execution.taskId);
    this.tasksByParent.set(parentId, parentTasks);

    return execution;
  }

  /**
   * Start a task (mark as running)
   */
  startTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'pending') {
      task.status = 'running';
      task.startedAt = Date.now();
    }
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): TaskExecution | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get task by child instance ID
   */
  getTaskByChildId(childId: string): TaskExecution | undefined {
    const taskId = this.tasksByChild.get(childId);
    return taskId ? this.tasks.get(taskId) : undefined;
  }

  /**
   * Get all tasks for a parent instance
   */
  getTasksByParentId(parentId: string): TaskExecution[] {
    const taskIds = this.tasksByParent.get(parentId) || [];
    return taskIds
      .map(id => this.tasks.get(id))
      .filter((t): t is TaskExecution => t !== undefined);
  }

  /**
   * Update task progress
   */
  updateProgress(taskIdOrChildId: string, progress: TaskProgress): boolean {
    const task = this.tasks.get(taskIdOrChildId) || this.getTaskByChildId(taskIdOrChildId);
    if (!task) return false;

    task.progress = progress;
    return true;
  }

  /**
   * Complete a task successfully
   */
  completeTask(taskIdOrChildId: string, result: TaskResult): boolean {
    const task = this.tasks.get(taskIdOrChildId) || this.getTaskByChildId(taskIdOrChildId);
    if (!task) return false;

    task.status = 'completed';
    task.completedAt = Date.now();
    task.result = result;
    task.progress = {
      percentage: 100,
      currentStep: 'Completed',
    };

    this.moveToHistory(task);
    return true;
  }

  /**
   * Fail a task
   */
  failTask(taskIdOrChildId: string, error: TaskError): boolean {
    const task = this.tasks.get(taskIdOrChildId) || this.getTaskByChildId(taskIdOrChildId);
    if (!task) return false;

    task.status = 'failed';
    task.completedAt = Date.now();
    task.error = error;

    this.moveToHistory(task);
    return true;
  }

  /**
   * Cancel a task
   */
  cancelTask(taskIdOrChildId: string): boolean {
    const task = this.tasks.get(taskIdOrChildId) || this.getTaskByChildId(taskIdOrChildId);
    if (!task) return false;

    task.status = 'cancelled';
    task.completedAt = Date.now();

    this.moveToHistory(task);
    return true;
  }

  /**
   * Move a task to history
   */
  private moveToHistory(task: TaskExecution): void {
    // Remove from active tracking
    this.tasks.delete(task.taskId);
    this.tasksByChild.delete(task.childId);

    const parentTasks = this.tasksByParent.get(task.parentId);
    if (parentTasks) {
      const index = parentTasks.indexOf(task.taskId);
      if (index !== -1) {
        parentTasks.splice(index, 1);
      }
    }

    // Add to history
    this.completedTasks.push(task);

    // Trim history if needed
    if (this.completedTasks.length > this.maxHistorySize) {
      this.completedTasks = this.completedTasks.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get task history for an instance
   */
  getTaskHistory(parentId?: string): TaskHistory {
    const relevantTasks = parentId
      ? this.completedTasks.filter(t => t.parentId === parentId)
      : this.completedTasks;

    const activeTasks = parentId
      ? this.getTasksByParentId(parentId)
      : Array.from(this.tasks.values());

    return {
      totalTasks: relevantTasks.length + activeTasks.length,
      completedTasks: relevantTasks.filter(t => t.status === 'completed').length,
      failedTasks: relevantTasks.filter(t => t.status === 'failed').length,
      cancelledTasks: relevantTasks.filter(t => t.status === 'cancelled').length,
      activeTasks: activeTasks.length,
      recentTasks: [...relevantTasks.slice(-50), ...activeTasks],
    };
  }

  /**
   * Queue a task for later execution
   */
  queueTask(
    parentId: string,
    task: string,
    options?: {
      name?: string;
      priority?: TaskPriority;
      workingDirectory?: string;
      timeout?: number;
    }
  ): QueuedTask {
    const queued: QueuedTask = {
      task,
      name: options?.name,
      priority: options?.priority || 'normal',
      workingDirectory: options?.workingDirectory,
      parentId,
      queuedAt: Date.now(),
      timeout: options?.timeout,
    };

    // Insert based on priority
    const insertIndex = this.taskQueue.findIndex(t => {
      const priorities: TaskPriority[] = ['critical', 'high', 'normal', 'low'];
      return priorities.indexOf(t.priority) > priorities.indexOf(queued.priority);
    });

    if (insertIndex === -1) {
      this.taskQueue.push(queued);
    } else {
      this.taskQueue.splice(insertIndex, 0, queued);
    }

    return queued;
  }

  /**
   * Get next task from queue
   */
  dequeueTask(): QueuedTask | undefined {
    return this.taskQueue.shift();
  }

  /**
   * Get queue length
   */
  getQueueLength(): number {
    return this.taskQueue.length;
  }

  /**
   * Clean up tasks for a terminated child
   */
  cleanupChildTasks(childId: string): void {
    const taskId = this.tasksByChild.get(childId);
    if (taskId) {
      this.cancelTask(taskId);
    }
  }

  /**
   * Clean up all tasks for a parent
   */
  cleanupParentTasks(parentId: string): void {
    const taskIds = this.tasksByParent.get(parentId) || [];
    for (const taskId of taskIds) {
      this.cancelTask(taskId);
    }

    // Remove queued tasks for this parent
    this.taskQueue = this.taskQueue.filter(t => t.parentId !== parentId);
  }

  /**
   * Check for timed out tasks
   */
  checkTimeouts(): TaskExecution[] {
    const timedOut: TaskExecution[] = [];
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.timeout > 0 && task.startedAt) {
        const elapsed = now - task.startedAt;
        if (elapsed > task.timeout) {
          task.status = 'failed';
          task.completedAt = now;
          task.error = {
            code: 'TIMEOUT',
            message: `Task timed out after ${Math.round(elapsed / 1000)}s`,
            suggestedAction: 'retry',
          };
          timedOut.push(task);
          this.moveToHistory(task);
        }
      }
    }

    return timedOut;
  }

  /**
   * Serialize task for IPC
   */
  serializeTask(task: TaskExecution): Record<string, unknown> {
    return { ...task };
  }

  /**
   * Get stats
   */
  getStats(): {
    activeTasks: number;
    queuedTasks: number;
    completedTasks: number;
  } {
    return {
      activeTasks: this.tasks.size,
      queuedTasks: this.taskQueue.length,
      completedTasks: this.completedTasks.length,
    };
  }
}

// Singleton instance
let taskManager: TaskManager | null = null;

/**
 * Get the task manager instance
 */
export function getTaskManager(): TaskManager {
  if (!taskManager) {
    taskManager = new TaskManager();
  }
  return taskManager;
}
