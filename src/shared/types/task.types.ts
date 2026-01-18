/**
 * Task Types - Subagent task tracking and execution
 */

/**
 * Task status for subagent work
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Task priority level
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Task result returned by subagent
 */
export interface TaskResult {
  /** Whether the task completed successfully */
  success: boolean;
  /** Human-readable summary of what was accomplished */
  summary: string;
  /** Optional structured data from the task */
  data?: Record<string, unknown>;
  /** Files created or modified during the task */
  artifacts?: TaskArtifact[];
  /** Recommendations for follow-up actions */
  recommendations?: string[];
}

/**
 * Task artifact (file or data produced)
 */
export interface TaskArtifact {
  type: 'file' | 'data' | 'url';
  path?: string;
  name: string;
  description?: string;
}

/**
 * Task error information
 */
export interface TaskError {
  code: string;
  message: string;
  context?: string;
  suggestedAction?: 'retry' | 'abandon' | 'escalate' | 'modify';
}

/**
 * Task progress update
 */
export interface TaskProgress {
  /** Progress percentage (0-100) */
  percentage: number;
  /** Current step description */
  currentStep: string;
  /** Number of steps remaining (if known) */
  stepsRemaining?: number;
  /** Estimated time remaining in seconds (if known) */
  estimatedTimeRemaining?: number;
}

/**
 * Task execution record - tracks a spawned subagent task
 */
export interface TaskExecution {
  /** Unique task ID */
  taskId: string;
  /** Parent instance that spawned this task */
  parentId: string;
  /** Child instance executing the task */
  childId: string;
  /** Task description */
  task: string;
  /** Optional task name */
  name?: string;
  /** Task priority */
  priority: TaskPriority;
  /** Current status */
  status: TaskStatus;
  /** When the task was created */
  createdAt: number;
  /** When the task started executing */
  startedAt?: number;
  /** When the task completed (success or failure) */
  completedAt?: number;
  /** Latest progress update */
  progress?: TaskProgress;
  /** Task result (on completion) */
  result?: TaskResult;
  /** Task error (on failure) */
  error?: TaskError;
  /** Task timeout in milliseconds (0 = no timeout) */
  timeout: number;
  /** Working directory for the task */
  workingDirectory?: string;
}

/**
 * Task queue entry for pending tasks
 */
export interface QueuedTask {
  /** Task configuration */
  task: string;
  name?: string;
  priority: TaskPriority;
  workingDirectory?: string;
  /** Parent instance requesting the task */
  parentId: string;
  /** When the task was queued */
  queuedAt: number;
  /** Optional timeout */
  timeout?: number;
}

/**
 * Task history summary for an instance
 */
export interface TaskHistory {
  /** Total tasks spawned */
  totalTasks: number;
  /** Completed successfully */
  completedTasks: number;
  /** Failed tasks */
  failedTasks: number;
  /** Cancelled tasks */
  cancelledTasks: number;
  /** Currently running tasks */
  activeTasks: number;
  /** Recent task executions (last 50) */
  recentTasks: TaskExecution[];
}

/**
 * Create a new task execution record
 */
export function createTaskExecution(
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
  return {
    taskId: crypto.randomUUID(),
    parentId,
    childId,
    task,
    name: options?.name,
    priority: options?.priority || 'normal',
    status: 'pending',
    createdAt: Date.now(),
    timeout: options?.timeout || 0,
    workingDirectory: options?.workingDirectory,
  };
}

/**
 * Serialize task execution for IPC
 */
export function serializeTaskExecution(task: TaskExecution): Record<string, unknown> {
  return { ...task };
}

/**
 * Task completion command from child to parent
 */
export interface TaskCompleteCommand {
  action: 'report_task_complete';
  taskId?: string;  // Optional - if not provided, completes the current task
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  artifacts?: TaskArtifact[];
  recommendations?: string[];
}

/**
 * Task progress command from child to parent
 */
export interface TaskProgressCommand {
  action: 'report_progress';
  taskId?: string;  // Optional - if not provided, updates the current task
  percentage: number;
  currentStep: string;
  stepsRemaining?: number;
}

/**
 * Task error command from child to parent
 */
export interface TaskErrorCommand {
  action: 'report_error';
  taskId?: string;
  code: string;
  message: string;
  context?: string;
  suggestedAction?: 'retry' | 'abandon' | 'escalate' | 'modify';
}
