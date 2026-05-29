/**
 * Orchestration Protocol - Type definitions and marker constants.
 * Kept in a separate module so prompt-generation code can import
 * types here without creating a circular dependency back to the
 * protocol barrel.
 */

import type {
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand
} from '../../shared/types/child-result.types';
import type { ConsensusStrategy } from './consensus.types';
import type { CanonicalCliType } from '../../shared/types/settings.types';
import type {
  AutomationAction,
  AutomationConcurrencyPolicy,
  AutomationMissedRunPolicy,
  AutomationSchedule,
} from '../../shared/types/automation.types';

export const ORCHESTRATION_MARKER_START = ':::ORCHESTRATOR_COMMAND:::';
export const ORCHESTRATION_MARKER_END = ':::END_COMMAND:::';

export type OrchestratorAction =
  | 'spawn_child'
  | 'message_child'
  | 'get_children'
  | 'terminate_child'
  | 'get_child_output'
  | 'call_tool'
  | 'report_task_complete'
  | 'report_progress'
  | 'report_error'
  | 'get_task_status'
  | 'request_user_action'
  | 'create_automation'
  // Structured result commands
  | 'report_result'
  | 'get_child_summary'
  | 'get_child_artifacts'
  | 'get_child_section'
  // Multi-model consensus
  | 'consensus_query';

export interface SpawnChildCommand {
  action: 'spawn_child';
  task: string;
  name?: string;
  workingDirectory?: string;
  agentId?: string;
  model?: string;
  /** CLI provider to use: any CanonicalCliType value, or 'auto' (default) */
  provider?: CanonicalCliType;
  /** Explicitly enable YOLO for this child (requires user confirmation upstream) */
  yoloMode?: boolean;
  /** Connected worker node (id or name, e.g. "windows-pc") to run this child on. Omit to run locally / inherit the parent's machine. */
  node?: string;
}

export interface MessageChildCommand {
  action: 'message_child';
  childId: string;
  message: string;
}

export interface GetChildrenCommand {
  action: 'get_children';
}

export interface TerminateChildCommand {
  action: 'terminate_child';
  childId: string;
}

export interface GetChildOutputCommand {
  action: 'get_child_output';
  childId: string;
  lastN?: number;
}

export interface CallToolCommand {
  action: 'call_tool';
  toolId: string;
  args?: unknown;
}

export interface ReportTaskCompleteCommand {
  action: 'report_task_complete';
  taskId?: string;
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  artifacts?: {
    type: 'file' | 'data' | 'url';
    path?: string;
    name: string;
    description?: string;
  }[];
  recommendations?: string[];
}

export interface ReportProgressCommand {
  action: 'report_progress';
  taskId?: string;
  percentage: number;
  currentStep: string;
  stepsRemaining?: number;
}

export interface ReportErrorCommand {
  action: 'report_error';
  taskId?: string;
  code: string;
  message: string;
  context?: string;
  suggestedAction?: 'retry' | 'abandon' | 'escalate' | 'modify';
}

export interface GetTaskStatusCommand {
  action: 'get_task_status';
  taskId?: string;
}

/**
 * Request types that can be sent to the user
 */
export type UserActionRequestType =
  | 'switch_mode' // Request to switch from plan to build mode (or vice versa)
  | 'approve_action' // Request approval for a specific action
  | 'confirm' // Generic confirmation request
  | 'select_option' // Request user to select from options
  | 'ask_questions'; // Ask user free-form questions (renders text inputs)

/**
 * Request user action command - asks the user to approve/confirm something
 */
export interface RequestUserActionCommand {
  action: 'request_user_action';
  /** Type of request */
  requestType: UserActionRequestType;
  /** Title shown to user */
  title: string;
  /** Detailed message explaining what's being requested */
  message: string;
  /** For switch_mode: the target mode */
  targetMode?: 'build' | 'plan' | 'review';
  /** For select_option: available options */
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  /** For ask_questions: list of questions to ask the user (renders text inputs) */
  questions?: string[];
  /** Additional context/metadata */
  context?: Record<string, unknown>;
}

/**
 * Consensus query - ask multiple AI providers the same question and get synthesized consensus
 */
export interface ConsensusQueryCommand {
  action: 'consensus_query';
  /** The question or prompt to send to all providers */
  question: string;
  /** Context to include with the question */
  context?: string;
  /** Which providers to query (default: all available) */
  providers?: Exclude<CanonicalCliType, 'auto'>[];
  /** Consensus strategy: 'majority' (default), 'weighted', or 'all' (no synthesis, raw responses) */
  strategy?: ConsensusStrategy;
  /** Timeout per provider in seconds (default: 60) */
  timeout?: number;
}

export interface CreateAutomationCommand {
  action: 'create_automation';
  automation: {
    name: string;
    description?: string;
    enabled?: boolean;
    schedule: AutomationSchedule;
    missedRunPolicy?: AutomationMissedRunPolicy;
    concurrencyPolicy?: AutomationConcurrencyPolicy;
    action: Omit<AutomationAction, 'workingDirectory'> & {
      workingDirectory?: string;
    };
  };
}

export type OrchestratorCommand =
  | SpawnChildCommand
  | MessageChildCommand
  | GetChildrenCommand
  | TerminateChildCommand
  | GetChildOutputCommand
  | CallToolCommand
  | ReportTaskCompleteCommand
  | ReportProgressCommand
  | ReportErrorCommand
  | GetTaskStatusCommand
  | RequestUserActionCommand
  | CreateAutomationCommand
  // Structured result commands
  | ReportResultCommand
  | GetChildSummaryCommand
  | GetChildArtifactsCommand
  | GetChildSectionCommand
  // Multi-model consensus
  | ConsensusQueryCommand;

/**
 * Minimal, display-oriented view of a connected worker node, injected into the
 * orchestrator prompt so the parent knows which `node` values are valid for
 * `spawn_child`. Decoupled from the full `WorkerNodeInfo` so this protocol
 * module stays free of main-process service imports.
 */
export interface OrchestratorNodeSummary {
  id: string;
  name: string;
  platform?: string;
  cpuCores?: number;
  totalMemoryMB?: number;
  gpuName?: string;
  supportedClis?: string[];
  hasBrowserRuntime?: boolean;
  hasDocker?: boolean;
  activeInstances?: number;
  maxConcurrentInstances?: number;
}
