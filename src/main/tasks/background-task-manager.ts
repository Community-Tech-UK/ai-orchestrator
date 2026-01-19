/**
 * Background Task Manager
 *
 * Manage long-running background tasks:
 * - Task queuing and prioritization
 * - Progress tracking and reporting
 * - Cancellation support
 * - Resource management
 * - Task dependencies
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

export type TaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export interface TaskDefinition {
  /** Unique task identifier */
  id?: string;
  /** Human-readable name */
  name: string;
  /** Task type for categorization */
  type: string;
  /** Priority level */
  priority?: TaskPriority;
  /** Dependencies on other tasks */
  dependsOn?: string[];
  /** Task payload/parameters */
  payload?: Record<string, unknown>;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether task can be cancelled */
  cancellable?: boolean;
  /** Associated instance ID */
  instanceId?: string;
}

export interface Task extends TaskDefinition {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  progress: number;
  progressMessage?: string;
  result?: unknown;
  error?: string;
  retryCount: number;
  maxRetries: number;
  timeout: number;
  cancellable: boolean;
}

export interface TaskProgress {
  taskId: string;
  progress: number;
  message?: string;
  data?: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  result?: unknown;
  error?: string;
  duration: number;
}

export type TaskExecutor = (
  task: Task,
  context: TaskExecutionContext
) => Promise<unknown>;

export interface TaskExecutionContext {
  /** Report progress */
  reportProgress: (progress: number, message?: string) => void;
  /** Check if cancellation requested */
  isCancelled: () => boolean;
  /** Get task payload */
  getPayload: <T>() => T;
  /** Emit custom event */
  emit: (event: string, data: unknown) => void;
}

export interface TaskManagerConfig {
  /** Maximum concurrent tasks */
  maxConcurrent: number;
  /** Default task timeout */
  defaultTimeout: number;
  /** Default max retries */
  defaultMaxRetries: number;
  /** Task history limit */
  historyLimit: number;
  /** Enable auto-start */
  autoStart: boolean;
}

const DEFAULT_CONFIG: TaskManagerConfig = {
  maxConcurrent: 3,
  defaultTimeout: 300000, // 5 minutes
  defaultMaxRetries: 2,
  historyLimit: 100,
  autoStart: true,
};

const PRIORITY_VALUES: Record<TaskPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export class BackgroundTaskManager extends EventEmitter {
  private static instance: BackgroundTaskManager | null = null;
  private config: TaskManagerConfig;
  private tasks: Map<string, Task> = new Map();
  private taskHistory: Task[] = [];
  private executors: Map<string, TaskExecutor> = new Map();
  private runningTasks: Set<string> = new Set();
  private cancelledTasks: Set<string> = new Set();
  private paused: boolean = false;
  private processingQueue: boolean = false;

  private constructor() {
    super();
    this.config = { ...DEFAULT_CONFIG };
  }

  static getInstance(): BackgroundTaskManager {
    if (!BackgroundTaskManager.instance) {
      BackgroundTaskManager.instance = new BackgroundTaskManager();
    }
    return BackgroundTaskManager.instance;
  }

  /**
   * Update configuration
   */
  configure(config: Partial<TaskManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config-updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): TaskManagerConfig {
    return { ...this.config };
  }

  /**
   * Register a task executor
   */
  registerExecutor(type: string, executor: TaskExecutor): void {
    this.executors.set(type, executor);
    this.emit('executor-registered', { type });
  }

  /**
   * Unregister a task executor
   */
  unregisterExecutor(type: string): boolean {
    const removed = this.executors.delete(type);
    if (removed) {
      this.emit('executor-unregistered', { type });
    }
    return removed;
  }

  /**
   * Submit a new task
   */
  submit(definition: TaskDefinition): Task {
    const task: Task = {
      ...definition,
      id: definition.id || uuidv4(),
      status: 'pending',
      priority: definition.priority || 'normal',
      createdAt: Date.now(),
      progress: 0,
      retryCount: 0,
      maxRetries: definition.maxRetries ?? this.config.defaultMaxRetries,
      timeout: definition.timeout ?? this.config.defaultTimeout,
      cancellable: definition.cancellable ?? true,
    };

    this.tasks.set(task.id, task);
    this.emit('task-submitted', task);

    // Auto-start queue processing
    if (this.config.autoStart && !this.paused) {
      this.processQueue();
    }

    return task;
  }

  /**
   * Submit multiple tasks
   */
  submitBatch(definitions: TaskDefinition[]): Task[] {
    const tasks = definitions.map(def => this.submit(def));
    this.emit('batch-submitted', { count: tasks.length, taskIds: tasks.map(t => t.id) });
    return tasks;
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks
   */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get tasks by status
   */
  getTasksByStatus(status: TaskStatus): Task[] {
    return this.getAllTasks().filter(t => t.status === status);
  }

  /**
   * Get tasks by type
   */
  getTasksByType(type: string): Task[] {
    return this.getAllTasks().filter(t => t.type === type);
  }

  /**
   * Get tasks by instance
   */
  getTasksByInstance(instanceId: string): Task[] {
    return this.getAllTasks().filter(t => t.instanceId === instanceId);
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (!task.cancellable) {
      this.emit('cancel-rejected', { taskId, reason: 'Task is not cancellable' });
      return false;
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    this.cancelledTasks.add(taskId);

    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.completedAt = Date.now();
      this.moveToHistory(task);
      this.emit('task-cancelled', task);
    } else {
      // Running task - will be cancelled in execution context
      this.emit('task-cancel-requested', { taskId });
    }

    return true;
  }

  /**
   * Cancel all tasks
   */
  cancelAll(): number {
    let cancelled = 0;
    for (const task of this.tasks.values()) {
      if (this.cancel(task.id)) {
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * Pause queue processing
   */
  pause(): void {
    this.paused = true;
    this.emit('paused');
  }

  /**
   * Resume queue processing
   */
  resume(): void {
    this.paused = false;
    this.emit('resumed');
    this.processQueue();
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Retry a failed task
   */
  retry(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'failed') return undefined;

    task.status = 'pending';
    task.error = undefined;
    task.progress = 0;
    task.progressMessage = undefined;
    task.retryCount++;

    this.emit('task-retried', task);
    this.processQueue();

    return task;
  }

  /**
   * Process the task queue
   */
  private async processQueue(): Promise<void> {
    if (this.processingQueue || this.paused) return;
    this.processingQueue = true;

    try {
      while (true) {
        // Check capacity
        if (this.runningTasks.size >= this.config.maxConcurrent) {
          break;
        }

        // Get next task
        const nextTask = this.getNextTask();
        if (!nextTask) {
          break;
        }

        // Execute task (don't await - run in parallel)
        this.executeTask(nextTask).catch(err => {
          this.emit('error', { taskId: nextTask.id, error: err.message });
        });
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * Get the next task to execute
   */
  private getNextTask(): Task | undefined {
    const pendingTasks = this.getTasksByStatus('pending')
      .filter(task => this.areDependenciesMet(task))
      .sort((a, b) => {
        // Sort by priority (higher first), then by creation time (earlier first)
        const priorityDiff = PRIORITY_VALUES[b.priority] - PRIORITY_VALUES[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return a.createdAt - b.createdAt;
      });

    return pendingTasks[0];
  }

  /**
   * Check if task dependencies are met
   */
  private areDependenciesMet(task: Task): boolean {
    if (!task.dependsOn || task.dependsOn.length === 0) return true;

    return task.dependsOn.every(depId => {
      const depTask = this.tasks.get(depId) || this.taskHistory.find(t => t.id === depId);
      return depTask?.status === 'completed';
    });
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: Task): Promise<void> {
    const executor = this.executors.get(task.type);
    if (!executor) {
      task.status = 'failed';
      task.error = `No executor registered for type: ${task.type}`;
      task.completedAt = Date.now();
      this.moveToHistory(task);
      this.emit('task-failed', task);
      return;
    }

    // Mark as running
    task.status = 'running';
    task.startedAt = Date.now();
    this.runningTasks.add(task.id);
    this.emit('task-started', task);

    // Create execution context
    const context: TaskExecutionContext = {
      reportProgress: (progress: number, message?: string) => {
        task.progress = Math.min(100, Math.max(0, progress));
        task.progressMessage = message;
        this.emit('task-progress', {
          taskId: task.id,
          progress: task.progress,
          message,
        });
      },
      isCancelled: () => this.cancelledTasks.has(task.id),
      getPayload: <T>() => (task.payload as T) || ({} as T),
      emit: (event: string, data: unknown) => {
        this.emit(`task:${event}`, { taskId: task.id, data });
      },
    };

    // Set up timeout
    const timeoutId = setTimeout(() => {
      this.cancelledTasks.add(task.id);
      this.emit('task-timeout', { taskId: task.id, timeout: task.timeout });
    }, task.timeout);

    try {
      const result = await executor(task, context);

      clearTimeout(timeoutId);

      // Check if cancelled during execution
      if (this.cancelledTasks.has(task.id)) {
        task.status = 'cancelled';
        task.completedAt = Date.now();
        this.emit('task-cancelled', task);
      } else {
        task.status = 'completed';
        task.result = result;
        task.progress = 100;
        task.completedAt = Date.now();
        this.emit('task-completed', task);
      }
    } catch (error) {
      clearTimeout(timeoutId);

      task.error = (error as Error).message;

      // Check if should retry
      if (task.retryCount < task.maxRetries && !this.cancelledTasks.has(task.id)) {
        task.status = 'pending';
        task.retryCount++;
        task.progress = 0;
        this.emit('task-retry-scheduled', { taskId: task.id, attempt: task.retryCount });
      } else {
        task.status = 'failed';
        task.completedAt = Date.now();
        this.emit('task-failed', task);
      }
    } finally {
      this.runningTasks.delete(task.id);
      this.cancelledTasks.delete(task.id);

      // Move to history if terminal state
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.moveToHistory(task);
      }

      // Process next task
      if (!this.paused) {
        this.processQueue();
      }
    }
  }

  /**
   * Move task to history
   */
  private moveToHistory(task: Task): void {
    this.tasks.delete(task.id);
    this.taskHistory.push(task);

    // Trim history if needed
    while (this.taskHistory.length > this.config.historyLimit) {
      this.taskHistory.shift();
    }
  }

  /**
   * Get task history
   */
  getHistory(options?: {
    type?: string;
    status?: TaskStatus;
    limit?: number;
  }): Task[] {
    let history = [...this.taskHistory];

    if (options?.type) {
      history = history.filter(t => t.type === options.type);
    }

    if (options?.status) {
      history = history.filter(t => t.status === options.status);
    }

    if (options?.limit) {
      history = history.slice(-options.limit);
    }

    return history;
  }

  /**
   * Clear task history
   */
  clearHistory(): void {
    this.taskHistory = [];
    this.emit('history-cleared');
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    totalInQueue: number;
    totalInHistory: number;
    avgCompletionTime: number;
  } {
    const allTasks = this.getAllTasks();
    const pending = allTasks.filter(t => t.status === 'pending').length;
    const running = allTasks.filter(t => t.status === 'running').length;

    const completedHistory = this.taskHistory.filter(t => t.status === 'completed');
    const failedHistory = this.taskHistory.filter(t => t.status === 'failed');
    const cancelledHistory = this.taskHistory.filter(t => t.status === 'cancelled');

    const avgCompletionTime = completedHistory.length > 0
      ? completedHistory.reduce((sum, t) => sum + (t.completedAt! - t.startedAt!), 0) / completedHistory.length
      : 0;

    return {
      pending,
      running,
      completed: completedHistory.length,
      failed: failedHistory.length,
      cancelled: cancelledHistory.length,
      totalInQueue: allTasks.length,
      totalInHistory: this.taskHistory.length,
      avgCompletionTime,
    };
  }

  /**
   * Wait for a task to complete
   */
  async waitFor(taskId: string, timeout?: number): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      const checkTask = () => {
        const task = this.tasks.get(taskId) || this.taskHistory.find(t => t.id === taskId);

        if (!task) {
          reject(new Error(`Task not found: ${taskId}`));
          return true;
        }

        if (['completed', 'failed', 'cancelled'].includes(task.status)) {
          resolve({
            taskId: task.id,
            success: task.status === 'completed',
            result: task.result,
            error: task.error,
            duration: task.completedAt! - (task.startedAt || task.createdAt),
          });
          return true;
        }

        return false;
      };

      // Check immediately
      if (checkTask()) return;

      // Set up listener
      const onComplete = (completedTask: Task) => {
        if (completedTask.id === taskId && checkTask()) {
          cleanup();
        }
      };

      const cleanup = () => {
        this.off('task-completed', onComplete);
        this.off('task-failed', onComplete);
        this.off('task-cancelled', onComplete);
      };

      this.on('task-completed', onComplete);
      this.on('task-failed', onComplete);
      this.on('task-cancelled', onComplete);

      // Set up timeout
      if (timeout) {
        setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for task: ${taskId}`));
        }, timeout);
      }
    });
  }
}

export default BackgroundTaskManager;
