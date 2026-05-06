import type { FileAttachment, InstanceProvider } from './instance.types';

export type AutomationScheduleType = 'cron' | 'oneTime';
export type AutomationMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type AutomationConcurrencyPolicy = 'skip' | 'queue';
export type AutomationTrigger = 'scheduled' | 'catchUp' | 'manual' | 'webhook' | 'channel' | 'providerRuntime' | 'orchestrationEvent';
export type AutomationRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type AutomationReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type AutomationDeliveryMode = 'notify' | 'silent' | 'localOnly';

export interface AutomationTriggerSource {
  type: AutomationTrigger;
  id?: string;
  eventType?: string;
  deliveryId?: string;
  instanceId?: string;
  provider?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export type AutomationSchedule =
  | {
      type: 'cron';
      expression: string;
      timezone: string;
    }
  | {
      type: 'oneTime';
      runAt: number;
      timezone?: string;
    };

export interface AutomationAction {
  prompt: string;
  workingDirectory: string;
  provider?: InstanceProvider;
  model?: string;
  agentId?: string;
  yoloMode?: boolean;
  reasoningEffort?: AutomationReasoningEffort;
  forceNodeId?: string;
  attachments?: FileAttachment[];
}

export type AutomationDestination =
  | {
      kind: 'newInstance';
    }
  | {
      kind: 'thread';
      instanceId: string;
      sessionId?: string;
      historyEntryId?: string;
      reviveIfArchived: boolean;
    };

export interface AutomationConfigSnapshot {
  name: string;
  schedule: AutomationSchedule;
  missedRunPolicy: AutomationMissedRunPolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  destination: AutomationDestination;
  action: AutomationAction;
}

export interface Automation {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  active: boolean;
  schedule: AutomationSchedule;
  missedRunPolicy: AutomationMissedRunPolicy;
  concurrencyPolicy: AutomationConcurrencyPolicy;
  destination: AutomationDestination;
  action: AutomationAction;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
  unreadRunCount?: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  status: AutomationRunStatus;
  trigger: AutomationTrigger;
  scheduledAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  instanceId: string | null;
  error: string | null;
  outputSummary: string | null;
  outputFullRef: string | null;
  idempotencyKey: string | null;
  triggerSource: AutomationTriggerSource | null;
  deliveryMode: AutomationDeliveryMode;
  seenAt: number | null;
  createdAt: number;
  updatedAt: number;
  configSnapshot: AutomationConfigSnapshot | null;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: AutomationSchedule;
  missedRunPolicy?: AutomationMissedRunPolicy;
  concurrencyPolicy?: AutomationConcurrencyPolicy;
  destination?: AutomationDestination;
  action: AutomationAction;
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  active?: boolean;
  schedule?: AutomationSchedule;
  missedRunPolicy?: AutomationMissedRunPolicy;
  concurrencyPolicy?: AutomationConcurrencyPolicy;
  destination?: AutomationDestination;
  action?: AutomationAction;
}

export interface FireAutomationOptions {
  trigger: AutomationTrigger;
  scheduledAt?: number;
  idempotencyKey?: string;
  triggerSource?: AutomationTriggerSource;
  deliveryMode?: AutomationDeliveryMode;
}

export type AutomationFireOutcome =
  | { status: 'started'; run: AutomationRun }
  | { status: 'queued'; run: AutomationRun }
  | { status: 'skipped'; run?: AutomationRun; reason: string };

export interface ClaimedAutomationRun {
  run: AutomationRun;
  automation: Automation;
  snapshot: AutomationConfigSnapshot;
}
