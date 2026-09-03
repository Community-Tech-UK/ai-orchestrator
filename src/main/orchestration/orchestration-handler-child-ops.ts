/**
 * Child task-report and structured-result handlers.
 *
 * Extracted from `orchestration-handler.ts` so the coordinator stays inside
 * its LOC ceiling. Callers pass the live context port; this module does not
 * own instance state. Behaviour matches the previous private methods.
 */

import { getLogger } from '../logging/logger';
import { getTaskManager } from './task-manager';
import type {
  ReportTaskCompleteCommand,
  ReportProgressCommand,
  ReportErrorCommand,
  GetTaskStatusCommand,
} from './orchestration-protocol';
import type {
  TaskResult,
  TaskProgress,
  TaskError,
} from '../../shared/types/task.types';
import type {
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand,
  ChildSummaryResponse,
  ChildArtifactsResponse,
  ChildSectionResponse,
} from '../../shared/types/child-result.types';
import type { OrchestrationContext } from './orchestration-handler.types';
import type { AdmissionOutcome } from '../session/session-admission-service';

const logger = getLogger('OrchestrationHandler');

export interface OrchestrationChildOpsHost {
  getContext(instanceId: string): OrchestrationContext | undefined;
  isChildOfParent(parentId: string, childId: string): boolean;
  injectResponse(
    instanceId: string,
    action: string,
    success: boolean,
    data: unknown,
    options?: { alreadyAdmitted?: boolean },
  ): AdmissionOutcome | null;
  emit(event: string, ...args: unknown[]): boolean;
}

export function handleReportTaskComplete(
  host: OrchestrationChildOpsHost,
  childId: string,
  command: ReportTaskCompleteCommand,
): void {
  const ctx = host.getContext(childId);
  if (!ctx || !ctx.parentId) {
    logger.warn('No parent for child to report completion to', { childId });
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
    host.emit('task-complete', ctx.parentId, childId, task);
  }

  host.injectResponse(ctx.parentId, 'task_complete', true, {
    childId,
    taskId: task?.taskId,
    result,
    message: `Child ${childId} completed task: ${command.summary}`,
  });
}

export function handleReportProgress(
  host: OrchestrationChildOpsHost,
  childId: string,
  command: ReportProgressCommand,
): void {
  const ctx = host.getContext(childId);
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
  host.emit('task-progress', ctx.parentId, childId, progress);

  if (command.percentage % 25 === 0) {
    host.injectResponse(ctx.parentId, 'task_progress', true, {
      childId,
      progress,
    });
  }
}

export function handleReportError(
  host: OrchestrationChildOpsHost,
  childId: string,
  command: ReportErrorCommand,
): void {
  const ctx = host.getContext(childId);
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

  host.emit('task-error', ctx.parentId, childId, error);

  host.injectResponse(ctx.parentId, 'task_error', true, {
    childId,
    taskId: task?.taskId,
    error,
    message: `Child ${childId} reported error: ${command.message}`,
  });
}

export function handleGetTaskStatus(
  host: OrchestrationChildOpsHost,
  instanceId: string,
  command: GetTaskStatusCommand,
): void {
  const ctx = host.getContext(instanceId);
  if (!ctx) return;

  const taskManager = getTaskManager();

  if (command.taskId) {
    const task = taskManager.getTask(command.taskId);
    host.injectResponse(instanceId, 'get_task_status', !!task, {
      task: task ? taskManager.serializeTask(task) : null,
    });
  } else {
    const tasks = ctx.parentId
      ? []
      : taskManager.getTasksByParentId(instanceId);

    host.injectResponse(instanceId, 'get_task_status', true, {
      tasks: tasks.map((t) => taskManager.serializeTask(t)),
      history: taskManager.getTaskHistory(instanceId),
    });
  }
}

export function handleReportResult(
  host: OrchestrationChildOpsHost,
  childId: string,
  command: ReportResultCommand,
): void {
  const ctx = host.getContext(childId);
  if (!ctx || !ctx.parentId) {
    logger.warn('No parent for child to report result to', { childId });
    return;
  }

  host.emit(
    'report-result',
    childId,
    command,
    (response: ChildSummaryResponse | null) => {
      if (response) {
        host.injectResponse(ctx.parentId!, 'child_result', true, {
          ...response,
          message: `Child ${childId} reported result: ${response.summary}`,
        });
      }
    },
  );
}

export function handleGetChildSummary(
  host: OrchestrationChildOpsHost,
  parentId: string,
  command: GetChildSummaryCommand,
): void {
  const ctx = host.getContext(parentId);
  if (!ctx) return;

  if (!host.isChildOfParent(parentId, command.childId)) {
    host.injectResponse(parentId, 'get_child_summary', false, {
      error: `Child ${command.childId} not found or not owned by you`,
    });
    return;
  }

  host.emit(
    'get-child-summary',
    parentId,
    command,
    (response: ChildSummaryResponse | null) => {
      if (response) {
        host.injectResponse(parentId, 'get_child_summary', true, response);
      } else {
        host.injectResponse(parentId, 'get_child_summary', false, {
          childId: command.childId,
          error: 'No structured result available. Child may not have completed yet or used report_task_complete instead.',
          suggestion: 'Use get_child_output to see raw output',
        });
      }
    },
  );
}

export function handleGetChildArtifacts(
  host: OrchestrationChildOpsHost,
  parentId: string,
  command: GetChildArtifactsCommand,
): void {
  const ctx = host.getContext(parentId);
  if (!ctx) return;

  if (!host.isChildOfParent(parentId, command.childId)) {
    host.injectResponse(parentId, 'get_child_artifacts', false, {
      error: `Child ${command.childId} not found or not owned by you`,
    });
    return;
  }

  host.emit(
    'get-child-artifacts',
    parentId,
    command,
    (response: ChildArtifactsResponse | null) => {
      if (response) {
        host.injectResponse(parentId, 'get_child_artifacts', true, response);
      } else {
        host.injectResponse(parentId, 'get_child_artifacts', false, {
          childId: command.childId,
          error: 'No artifacts available for this child',
        });
      }
    },
  );
}

export function handleGetChildSection(
  host: OrchestrationChildOpsHost,
  parentId: string,
  command: GetChildSectionCommand,
): void {
  const ctx = host.getContext(parentId);
  if (!ctx) return;

  if (!host.isChildOfParent(parentId, command.childId)) {
    host.injectResponse(parentId, 'get_child_section', false, {
      error: `Child ${command.childId} not found or not owned by you`,
    });
    return;
  }

  host.emit(
    'get-child-section',
    parentId,
    command,
    (response: ChildSectionResponse | null) => {
      if (response) {
        if (command.section === 'full' && response.tokenCount > 5000) {
          host.injectResponse(parentId, 'get_child_section', true, {
            ...response,
            warning: `Full transcript is ${response.tokenCount} tokens. Consider using get_child_summary or get_child_artifacts instead.`,
          });
        } else {
          host.injectResponse(parentId, 'get_child_section', true, response);
        }
      } else {
        host.injectResponse(parentId, 'get_child_section', false, {
          childId: command.childId,
          section: command.section,
          error: 'Section not available',
        });
      }
    },
  );
}
