/**
 * Orchestration Handler - Executes orchestrator commands from Claude instances
 */

import { EventEmitter } from 'events';
import {
  OrchestratorCommand,
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  ReportTaskCompleteCommand,
  ReportProgressCommand,
  ReportErrorCommand,
  GetTaskStatusCommand,
  parseOrchestratorCommands,
  formatCommandResponse,
  generateOrchestrationPrompt,
} from './orchestration-protocol';
import { getTaskManager } from './task-manager';
import type { TaskExecution, TaskResult, TaskProgress, TaskError } from '../../shared/types/task.types';

export interface OrchestrationContext {
  instanceId: string;
  workingDirectory: string;
  parentId: string | null;
  childrenIds: string[];
}

export interface OrchestrationEvents {
  'spawn-child': (parentId: string, command: SpawnChildCommand) => void;
  'message-child': (parentId: string, command: MessageChildCommand) => void;
  'terminate-child': (parentId: string, command: TerminateChildCommand) => void;
  'get-children': (parentId: string, callback: (children: ChildInfo[]) => void) => void;
  'get-child-output': (parentId: string, command: GetChildOutputCommand, callback: (output: string[]) => void) => void;
  'inject-response': (instanceId: string, response: string) => void;
  'task-complete': (parentId: string, childId: string, task: TaskExecution) => void;
  'task-progress': (parentId: string, childId: string, progress: TaskProgress) => void;
  'task-error': (parentId: string, childId: string, error: TaskError) => void;
}

export interface ChildInfo {
  id: string;
  name: string;
  status: string;
  createdAt: number;
}

export class OrchestrationHandler extends EventEmitter {
  private contexts: Map<string, OrchestrationContext> = new Map();

  /**
   * Register an instance for orchestration
   */
  registerInstance(
    instanceId: string,
    workingDirectory: string,
    parentId: string | null = null
  ): void {
    this.contexts.set(instanceId, {
      instanceId,
      workingDirectory,
      parentId,
      childrenIds: [],
    });
  }

  /**
   * Unregister an instance
   */
  unregisterInstance(instanceId: string): void {
    this.contexts.delete(instanceId);

    // Remove from parent's children list
    for (const ctx of this.contexts.values()) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== instanceId);
    }
  }

  /**
   * Add a child to a parent's context
   */
  addChild(parentId: string, childId: string): void {
    const ctx = this.contexts.get(parentId);
    if (ctx && !ctx.childrenIds.includes(childId)) {
      ctx.childrenIds.push(childId);
    }
  }

  /**
   * Get the orchestration prompt to prepend to the first message
   */
  getOrchestrationPrompt(instanceId: string): string {
    return generateOrchestrationPrompt(instanceId);
  }

  /**
   * Process output from an instance and execute any orchestrator commands
   */
  processOutput(instanceId: string, output: string): void {
    const commands = parseOrchestratorCommands(output);

    for (const command of commands) {
      this.executeCommand(instanceId, command);
    }
  }

  /**
   * Execute an orchestrator command
   */
  private executeCommand(instanceId: string, command: OrchestratorCommand): void {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) {
      console.warn(`No orchestration context for instance ${instanceId}`);
      return;
    }

    console.log(`Orchestrator: Executing ${command.action} from instance ${instanceId}`);

    switch (command.action) {
      case 'spawn_child':
        this.handleSpawnChild(instanceId, command);
        break;

      case 'message_child':
        this.handleMessageChild(instanceId, command);
        break;

      case 'get_children':
        this.handleGetChildren(instanceId);
        break;

      case 'terminate_child':
        this.handleTerminateChild(instanceId, command);
        break;

      case 'get_child_output':
        this.handleGetChildOutput(instanceId, command);
        break;

      case 'report_task_complete':
        this.handleReportTaskComplete(instanceId, command);
        break;

      case 'report_progress':
        this.handleReportProgress(instanceId, command);
        break;

      case 'report_error':
        this.handleReportError(instanceId, command);
        break;

      case 'get_task_status':
        this.handleGetTaskStatus(instanceId, command);
        break;
    }
  }

  private handleSpawnChild(parentId: string, command: SpawnChildCommand): void {
    this.emit('spawn-child', parentId, command);
  }

  private handleMessageChild(parentId: string, command: MessageChildCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'message_child', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('message-child', parentId, command);
  }

  private handleGetChildren(parentId: string): void {
    this.emit('get-children', parentId, (children: ChildInfo[]) => {
      this.injectResponse(parentId, 'get_children', true, { children });
    });
  }

  private handleTerminateChild(parentId: string, command: TerminateChildCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'terminate_child', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('terminate-child', parentId, command);
  }

  private handleGetChildOutput(parentId: string, command: GetChildOutputCommand): void {
    const ctx = this.contexts.get(parentId);
    if (!ctx) return;

    // Verify the child belongs to this parent
    if (!ctx.childrenIds.includes(command.childId)) {
      this.injectResponse(parentId, 'get_child_output', false, {
        error: `Child ${command.childId} not found or not owned by you`,
      });
      return;
    }

    this.emit('get-child-output', parentId, command, (output: string[]) => {
      this.injectResponse(parentId, 'get_child_output', true, { output });
    });
  }

  /**
   * Handle task completion report from child
   */
  private handleReportTaskComplete(childId: string, command: ReportTaskCompleteCommand): void {
    const ctx = this.contexts.get(childId);
    if (!ctx || !ctx.parentId) {
      console.warn(`No parent for child ${childId} to report completion to`);
      return;
    }

    const taskManager = getTaskManager();
    const task = taskManager.getTaskByChildId(childId);

    const result: TaskResult = {
      success: command.success,
      summary: command.summary,
      data: command.data,
      artifacts: command.artifacts,
      recommendations: command.recommendations,
    };

    if (task) {
      taskManager.completeTask(task.taskId, result);
      this.emit('task-complete', ctx.parentId, childId, task);
    }

    // Notify the parent instance
    this.injectResponse(ctx.parentId, 'task_complete', true, {
      childId,
      taskId: task?.taskId,
      result,
      message: `Child ${childId} completed task: ${command.summary}`,
    });
  }

  /**
   * Handle progress report from child
   */
  private handleReportProgress(childId: string, command: ReportProgressCommand): void {
    const ctx = this.contexts.get(childId);
    if (!ctx || !ctx.parentId) {
      return;
    }

    const taskManager = getTaskManager();
    const progress: TaskProgress = {
      percentage: command.percentage,
      currentStep: command.currentStep,
      stepsRemaining: command.stepsRemaining,
    };

    taskManager.updateProgress(childId, progress);
    this.emit('task-progress', ctx.parentId, childId, progress);

    // Optionally notify the parent (can be noisy, so only for significant progress)
    if (command.percentage % 25 === 0) {
      this.injectResponse(ctx.parentId, 'task_progress', true, {
        childId,
        progress,
      });
    }
  }

  /**
   * Handle error report from child
   */
  private handleReportError(childId: string, command: ReportErrorCommand): void {
    const ctx = this.contexts.get(childId);
    if (!ctx || !ctx.parentId) {
      return;
    }

    const taskManager = getTaskManager();
    const task = taskManager.getTaskByChildId(childId);

    const error: TaskError = {
      code: command.code,
      message: command.message,
      context: command.context,
      suggestedAction: command.suggestedAction,
    };

    if (task) {
      taskManager.failTask(task.taskId, error);
    }

    this.emit('task-error', ctx.parentId, childId, error);

    // Notify the parent instance
    this.injectResponse(ctx.parentId, 'task_error', true, {
      childId,
      taskId: task?.taskId,
      error,
      message: `Child ${childId} reported error: ${command.message}`,
    });
  }

  /**
   * Handle task status query
   */
  private handleGetTaskStatus(instanceId: string, command: GetTaskStatusCommand): void {
    const ctx = this.contexts.get(instanceId);
    if (!ctx) return;

    const taskManager = getTaskManager();

    if (command.taskId) {
      // Get specific task
      const task = taskManager.getTask(command.taskId);
      this.injectResponse(instanceId, 'get_task_status', !!task, {
        task: task ? taskManager.serializeTask(task) : null,
      });
    } else {
      // Get all tasks for this instance
      const tasks = ctx.parentId
        ? [] // Children don't have their own tasks
        : taskManager.getTasksByParentId(instanceId);

      this.injectResponse(instanceId, 'get_task_status', true, {
        tasks: tasks.map(t => taskManager.serializeTask(t)),
        history: taskManager.getTaskHistory(instanceId),
      });
    }
  }

  /**
   * Send a response back to the instance
   */
  private injectResponse(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown
  ): void {
    const response = formatCommandResponse(action as any, success, data);
    this.emit('inject-response', instanceId, response);
  }

  /**
   * Notify parent about a successful child spawn
   */
  notifyChildSpawned(parentId: string, childId: string, childName: string): void {
    this.addChild(parentId, childId);
    this.injectResponse(parentId, 'spawn_child', true, {
      childId,
      name: childName,
      message: 'Child instance created successfully',
    });
  }

  /**
   * Notify parent about a successful message delivery
   */
  notifyMessageSent(parentId: string, childId: string): void {
    this.injectResponse(parentId, 'message_child', true, {
      childId,
      message: 'Message delivered successfully',
    });
  }

  /**
   * Notify parent about a child termination
   */
  notifyChildTerminated(parentId: string, childId: string): void {
    const ctx = this.contexts.get(parentId);
    if (ctx) {
      ctx.childrenIds = ctx.childrenIds.filter((id) => id !== childId);
    }
    this.injectResponse(parentId, 'terminate_child', true, {
      childId,
      message: 'Child instance terminated',
    });
  }

  /**
   * Notify an instance about an error
   */
  notifyError(instanceId: string, error: string): void {
    this.injectResponse(instanceId, 'error', false, {
      error,
      message: error,
    });
  }
}
