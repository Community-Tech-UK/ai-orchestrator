import type { FileAttachment, InstanceProvider } from './instance.types';

export type AutomationScheduleType = 'cron' | 'oneTime';
export type AutomationMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type AutomationConcurrencyPolicy = 'skip' | 'queue';
export type AutomationTrigger = 'scheduled' | 'catchUp' | 'manual' | 'webhook' | 'channel' | 'providerRuntime' | 'orchestrationEvent';
export type AutomationRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type AutomationReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow';
export type AutomationDeliveryMode = 'notify' | 'silent' | 'localOnly';

/** A bounded, JSONPath-lite predicate for webhook payloads. */
export interface AutomationWebhookFilter {
  /** Dot-delimited path rooted at the webhook payload, such as `issue.state`. */
  path: string;
  operator: 'equals' | 'contains';
  value: string;
}

/**
 * The configured source of an automation, separate from the per-run trigger
 * provenance above. Existing automations are scheduled by default.
 */
export type AutomationConfiguredTrigger =
  | { kind: 'schedule' }
  | {
      kind: 'webhook';
      routeId: string;
      filters: AutomationWebhookFilter[];
    };

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

/**
 * Fable WS5: run the automation's prompt as an autonomous LOOP instead of a
 * one-shot instance turn ("issue in, worked branch out"). The prompt becomes
 * the loop goal (webhook payloads interpolate through the egress-gated
 * template first). WS6 verification-authority policy applies: an autonomous
 * implementation loop needs a real verify command, so it is required here.
 */
export interface AutomationLoopAction {
  /** Verification authority for autonomous completion (WS6 policy — required). */
  verifyCommand: string;
  /**
   * Run in an isolated per-run git worktree (default true — externally
   * triggered work must not dirty the operator's main checkout).
   */
  isolateWorkspace?: boolean;
  /** Iteration cap override (default: loop engine default). */
  maxIterations?: number;
  /** Cost cap override in cents (default: loop engine default). */
  maxCostCents?: number;
  /** Loop recipe name (default 'coding'). */
  loopRecipe?: string;
}

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
  /** WS5: when present, the action spawns a loop instead of a one-shot instance. */
  loop?: AutomationLoopAction;
  systemAction?:
    | {
        type: 'loopProviderLimitResume';
        loopRunId: string;
      }
    | {
        /**
         * Resume a paused *regular* (non-loop) interactive instance after a
         * provider quota/rate-limit reset. Mirrors `loopProviderLimitResume`
         * but re-sends the throttled user turn to the instance instead of
         * resuming a loop run. `resumePrompt` is the text to re-send; when
         * absent the handler falls back to the instance's last-sent message.
         */
        type: 'instanceProviderLimitResume';
        instanceId: string;
        resumePrompt?: string;
      };
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
  trigger: AutomationConfiguredTrigger;
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
  /**
   * Stable workspace/project identifier derived from `action.workingDirectory`
   * (normalized: trimmed + lowercased; blank -> `'__no_workspace__'`). Lets the
   * UI group automations by the project they target. Kept in sync with
   * `action.workingDirectory` by the store on create/update; never set by
   * callers. See `toWorkspaceId` in `shared/utils/workspace-key.ts`.
   */
  workspaceId: string;
  schedule: AutomationSchedule;
  trigger: AutomationConfiguredTrigger;
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
  /**
   * Number of consecutive failed runs since the last success. Reset to 0 on any
   * successful run and when the automation is re-enabled. Used to auto-disable a
   * persistently-failing automation so it stops firing on every schedule tick.
   */
  consecutiveFailures?: number;
  /** Epoch ms of the most recent failed run, if any. */
  lastFailureAt?: number | null;
  /** Error message from the most recent failed run, if any. */
  lastFailureReason?: string | null;
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
  /** WS5: the loop run this automation run spawned (loop actions only). */
  loopRunId: string | null;
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
  /** 1-based attempt number; 1 = first try, 2 = first retry, etc. */
  attempt: number;
  /** Maximum number of attempts allowed (including the first try). */
  maxAttempts: number;
}

export interface CreateAutomationInput {
  name: string;
  description?: string;
  enabled?: boolean;
  schedule: AutomationSchedule;
  trigger?: AutomationConfiguredTrigger;
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
  trigger?: AutomationConfiguredTrigger;
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
