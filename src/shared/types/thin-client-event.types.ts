import type { WorkflowLifecyclePhase } from './workflow-lifecycle.types';
import type { AutomationRunStatus } from './automation.types';
import type { InstanceStatus } from './instance.types';
import type { LoopStatus } from './loop.types';

export type EventTier =
  | 'lifecycle'
  | 'output'
  | 'status'
  | 'interaction'
  | 'control'
  | 'infra';

export interface ThinClientEvent<T = unknown> {
  /** Monotonically increasing sequence number, wrapping at u32 boundaries. */
  seq: number;
  /** Main-process wall-clock timestamp in epoch milliseconds. */
  ts: number;
  /** Subscription tier for transport-level filtering. */
  tier: EventTier;
  /** Domain event name, matching an existing IPC channel where possible. */
  type: string;
  /** Domain-specific payload. */
  payload: T;
}

export interface ThinClientCommand<T = unknown> {
  /** Unique client-chosen correlation ID. */
  cmdId: string;
  /** Narrow command vocabulary for non-Electron clients. */
  cmd: CommandName;
  /** Command-specific payload. */
  payload: T;
}

export type CommandName =
  | 'instance:create'
  | 'instance:send-input'
  | 'instance:terminate'
  | 'instance:interrupt'
  | 'instance:hibernate'
  | 'instance:wake'
  | 'instance:list'
  | 'instance:respond-input'
  | 'instance:respond-action'
  | 'loop:start'
  | 'loop:pause'
  | 'loop:resume'
  | 'loop:cancel'
  | 'loop:intervene'
  | 'loop:accept-completion'
  | 'chat:list'
  | 'chat:get'
  | 'chat:create'
  | 'chat:send-message'
  | 'snapshot:take'
  | 'session:list-resumable'
  | 'state:subscribe'
  | 'state:resync';

export interface InstancePhaseChangedPayload {
  instanceId: string;
  status: string;
  phase: WorkflowLifecyclePhase;
}

export interface LoopPhaseChangedPayload {
  loopRunId: string;
  chatId?: string;
  status: string;
  phase: WorkflowLifecyclePhase;
}

export interface AutomationPhaseChangedPayload {
  runId: string;
  automationId: string;
  status: string;
  phase: WorkflowLifecyclePhase;
}

export interface ThinClientLoopRunSnapshot {
  loopRunId: string;
  chatId: string;
  status: LoopStatus;
  phase: WorkflowLifecyclePhase;
  totalIterations: number;
  totalTokens: number;
  totalCostCents: number;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  initialPrompt: string;
  iterationPrompt: string | null;
  workspaceCwd: string;
}

export interface ThinClientAutomationRunSnapshot {
  runId: string;
  automationId: string;
  status: AutomationRunStatus;
  phase: WorkflowLifecyclePhase;
  instanceId: string | null;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ThinClientPauseStateSnapshot {
  isPaused: boolean;
  reasons: string[];
  pausedAt: number | null;
  lastChange: number;
}

export interface StateSyncSnapshot {
  instances: Record<string, unknown>[];
  loopRuns: ThinClientLoopRunSnapshot[];
  automationRuns: ThinClientAutomationRunSnapshot[];
  pauseState: ThinClientPauseStateSnapshot;
  memoryPressure: 'normal' | 'warning' | 'critical';
  seq: number;
}

export interface StateSubscribePayload {
  ipcAuthToken: string;
  tiers?: EventTier[] | 'all';
}

export interface StateSubscribeResult {
  tiers: EventTier[] | 'all';
}

export interface ThinClientCommandResponse<T = unknown> {
  cmdId: string;
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}

export type ThinClientSnapshotInstanceStatus = InstanceStatus;
