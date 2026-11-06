/**
 * Shared types for OrchestrationHandler — extracted to keep the handler file
 * within the project line-count ceiling. All symbols are re-exported from
 * orchestration-handler.ts so the public API is unchanged.
 */

import type {
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand,
  RequestUserActionCommand,
} from './orchestration-protocol';
import type {
  TaskExecution,
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
import type { SettledUserAction } from './user-action-lifecycle';

export interface OrchestrationContext {
  instanceId: string;
  workingDirectory: string;
  parentId: string | null;
  childrenIds: string[];
}

/**
 * Pending user action request (forwarded to UI)
 */
export interface UserActionRequest {
  id: string;
  instanceId: string;
  requestType: RequestUserActionCommand['requestType'];
  title: string;
  message: string;
  targetMode?: 'build' | 'plan' | 'review';
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  /** For ask_questions: list of questions to present with text inputs */
  questions?: string[];
  /** Secret metadata only; the typed value stays within the secret-card IPC path. */
  secretRequest?: RequestUserActionCommand['secretRequest'];
  context?: Record<string, unknown>;
  createdAt: number;
}

export interface OrchestrationEvents {
  'spawn-child': (parentId: string, command: SpawnChildCommand) => void;
  'message-child': (parentId: string, command: MessageChildCommand) => void;
  'terminate-child': (parentId: string, command: TerminateChildCommand) => void;
  'get-children': (
    parentId: string,
    callback: (children: ChildInfo[]) => void
  ) => void;
  'get-child-output': (
    parentId: string,
    command: GetChildOutputCommand,
    callback: (output: string[]) => void
  ) => void;
  'inject-response': (instanceId: string, response: string, confirm: (error?: Error) => void) => void;
  'task-complete': (
    parentId: string,
    childId: string,
    task: TaskExecution
  ) => void;
  'task-progress': (
    parentId: string,
    childId: string,
    progress: TaskProgress
  ) => void;
  'task-error': (parentId: string, childId: string, error: TaskError) => void;
  'user-action-request': (request: UserActionRequest) => void;
  /** A request closed: answered, timed out, stopped or the session went. Emitted once per request. */
  'user-action-resolved': (settled: SettledUserAction) => void;
  // New structured result events
  'report-result': (
    childId: string,
    command: ReportResultCommand,
    callback: (response: ChildSummaryResponse | null) => void
  ) => void;
  'get-child-summary': (
    parentId: string,
    command: GetChildSummaryCommand,
    callback: (response: ChildSummaryResponse | null) => void
  ) => void;
  'get-child-artifacts': (
    parentId: string,
    command: GetChildArtifactsCommand,
    callback: (response: ChildArtifactsResponse | null) => void
  ) => void;
  'get-child-section': (
    parentId: string,
    command: GetChildSectionCommand,
    callback: (response: ChildSectionResponse | null) => void
  ) => void;
}

export interface ChildInfo {
  id: string;
  name: string;
  status: string;
  createdAt: number;
}

export interface ChildTerminationResult {
  remainingChildren: number;
}

export interface CompletedChildSummary {
  childId: string;
  name: string;
  summary: string;
  success: boolean;
  conclusions: string[];
}
