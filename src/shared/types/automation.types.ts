import type { FileAttachment, InstanceProvider } from './instance.types';

export type AutomationScheduleType = 'cron' | 'oneTime';
export type AutomationMissedRunPolicy = 'skip' | 'notify' | 'runOnce';
export type AutomationConcurrencyPolicy = 'skip' | 'queue';
export type AutomationTrigger = 'scheduled' | 'catchUp' | 'manual' | 'webhook' | 'channel' | 'providerRuntime' | 'orchestrationEvent';
export type AutomationRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type AutomationReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | 'workflow';
export type AutomationDeliveryMode = 'notify' | 'silent' | 'localOnly';

/**
 * WS-C7 — the execution profile an automation action runs under.
 *
 * `'standard'` (the default when absent) preserves current behaviour exactly.
 * `'contained'` is an honest, opt-in containment posture: the resolved
 * provider (see `resolveAutomationSpawnTarget`) must be Codex — the only
 * provider with a real, technically-enforced sandbox in this codebase
 * (`sandboxMode: 'read-only'`, adapter-factory.ts `createCodexAdapter`) — and
 * the spawn environment is derived from `getSafeEnv()` instead of the
 * unfiltered pass-through, so no API keys, tokens, or other secrets from the
 * host environment reach the child process. A resolved provider other than
 * Codex fails the run at fire time with a plain-language reason; the run is
 * NEVER silently downgraded to standard/host execution.
 */
export type AutomationExecutionProfile = 'standard' | 'contained';

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
 * implementation loop needs a real verify command, enforced at dispatch.
 */
export interface AutomationLoopAction {
  /**
   * Verification authority for autonomous completion (WS6 policy). Blank means
   * "use whatever this working directory verifies with" — `prepareLoopStartConfig`
   * resolves and records the workspace's own verifier when the loop starts.
   */
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
  /**
   * WS-C7 — execution profile for this action. Absent means `'standard'`
   * (current behaviour, unchanged). See {@link AutomationExecutionProfile}.
   */
  executionProfile?: AutomationExecutionProfile;
  /**
   * WS-C7 — only meaningful when `executionProfile` is `'contained'`.
   * `'fail'` is the only honest option today: this codebase has no other
   * containment mechanism to fall back to, so a non-Codex resolved provider
   * always fails the run rather than silently running less contained than
   * requested. The field exists to make that refusal explicit/self-documenting
   * rather than an unstated implementation detail.
   */
  containedFallback?: 'fail';
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
  /**
   * Snapshotted {@link Automation.hidden} so a run's rail visibility follows the
   * config as it was when the run fired, not a later edit. Absent on snapshots
   * written before the field existed, which read as visible.
   */
  hidden?: boolean;
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
  /**
   * Keep this automation's sessions out of the project rail. For automations
   * whose real output lands somewhere else — a health check that only matters
   * when it fails, a run whose deliverable is an email or a board card — the
   * rail entry is noise that pushes hand-started sessions below the fold.
   *
   * This is a *rail* concept, not a secrecy one: the Automations page still
   * shows the automation and every run, output and error unchanged. A run that
   * fails, or parks waiting for a human, is shown in the rail regardless — a
   * silent health check that silently stops working is worse than the noise it
   * replaced.
   *
   * Orthogonal to the per-run {@link AutomationDeliveryMode}: `hidden` means
   * "not in the rail", `silent` means "don't notify me". A hidden automation
   * may still want to notify on failure.
   *
   * Applies only to automations that spawn their own session
   * (`destination.kind === 'newInstance'`). A thread-destination automation
   * sends into a session that already exists and that the operator may be using
   * themselves, so hiding it on the automation's behalf would be wrong; the
   * flag is intentionally inert there. Loop actions are also unaffected — their
   * sessions come from the loop engine, which carries no automation provenance
   * today (the rail's automation clock is already absent for them).
   */
  hidden?: boolean;
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
  /** See {@link Automation.hidden}. Defaults to visible. */
  hidden?: boolean;
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
  /** See {@link Automation.hidden}. */
  hidden?: boolean;
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
