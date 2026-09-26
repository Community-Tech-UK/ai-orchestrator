/**
 * Dependency-free wire contract shared by the desktop Mobile Gateway and the
 * standalone phone app. Keep host-only persistence/settings types out of this
 * module so either application can compile it without importing the other.
 */

export const MOBILE_ATTENTION_LEVELS = [
  'blocked',
  'failed',
  'review',
  'waiting',
  'working',
  'idle',
] as const;

export type MobileAttentionLevel = (typeof MOBILE_ATTENTION_LEVELS)[number];

export type MobileReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
  | 'workflow';

/** Request body for POST /pair. */
export interface MobilePairRequest {
  pairingToken: string;
  label?: string;
}

/** Response from POST /pair. */
export interface MobilePairResponse {
  deviceId: string;
  token: string;
  expiresAt: number;
  hostName: string;
}

/** A single instance/agent as the phone sees it. */
export interface MobileInstanceDto {
  id: string;
  displayName: string;
  status: string;
  attentionLevel: MobileAttentionLevel;
  provider: string;
  model?: string;
  workingDirectory: string;
  projectName: string;
  createdAt: number;
  lastActivity: number;
  parentId?: string;
  pendingApprovalCount: number;
  hasUnreadCompletion: boolean;
  isLooping?: boolean;
  contextPercentage?: number;
  queuedMessages?: MobileQueuedMessageDto[];
}

export interface MobileQueuedMessageDto {
  id: string;
  message: string;
  hasAttachments: boolean;
  enqueuedAt: number;
  attempts: number;
  error?: string;
}

export interface MobileModelDto {
  id: string;
  name: string;
  tier: 'fast' | 'balanced' | 'powerful';
  pinned?: boolean;
  family?: string;
}

export type MobileModelCatalog = Record<string, MobileModelDto[]>;

export interface MobileSessionPlan {
  provider: string;
  providerLabel: string;
  model: string | null;
  modelLabel: string | null;
  reasoningEffort: MobileReasoningEffort | null;
  reasoningEffortLabel: string | null;
}

export interface MobileProjectDto {
  key: string;
  path: string;
  name: string;
  sessionCount: number;
  busyCount: number;
  pendingApprovalCount: number;
  needsAttentionCount: number;
  lastActivity: number;
}

/** A transcript message as the phone renders it (a subset of OutputMessage). */
export interface MobileMessageDto {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  hasAttachments?: boolean;
  /** 0-based buffer index used as a resume cursor for `?fromSeq=N` replay. */
  seq?: number;
}

/** Response envelope for GET /api/instances/:id/messages?fromSeq=N. */
export interface MobileMessagesResumeDto {
  messages: MobileMessageDto[];
  meta: {
    fromSeq: number;
    returned: number;
    hasMore: boolean;
    maxSeq: number;
    /** Exclusive cursor for the next older page, including filtered buffer entries. */
    nextBeforeSeq?: number;
    /** Changes when the gateway detects that the live buffer was replaced. */
    bufferGeneration?: number;
    /** Changes whenever the gateway's process-local stream cursor state restarts. */
    cursorEpoch?: string;
    /** True when `fromSeq` no longer names the retained buffer generation/window. */
    bufferReset?: boolean;
    /** Current adapter-listener generation, when the provider reports one. */
    adapterGeneration?: number;
    /** Last output-only WebSocket sequence included in this HTTP snapshot. */
    streamSeq?: number;
  };
}

export type MobileUserActionRequestType =
  | 'switch_mode'
  | 'approve_action'
  | 'confirm'
  | 'select_option'
  | 'ask_questions';

export interface MobilePromptOptionDto {
  id: string;
  label: string;
  description?: string;
}

/**
 * Browser action risk classes mirrored from the Browser Gateway contract.
 * `credential` covers login/2FA/CAPTCHA steps: the phone shows "Open on your
 * Mac" and never offers approve/deny for them.
 */
export type MobileBrowserActionClass =
  | 'read'
  | 'navigate'
  | 'input'
  | 'credential'
  | 'file-upload'
  | 'file-download'
  | 'submit'
  | 'destructive'
  | 'financial_identity'
  | 'sensitive_identity'
  | 'payment'
  | 'unknown';

export interface MobilePromptDto {
  id: string;
  instanceId: string;
  requestId: string;
  kind: 'permission' | 'user-action' | 'browser';
  requestType?: MobileUserActionRequestType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  title: string;
  message: string;
  options?: MobilePromptOptionDto[];
  questions?: string[];
  createdAt: number;
  /** Present when `kind` is 'browser': the Browser Gateway approval request id. */
  browserRequestId?: string;
  /** Present when `kind` is 'browser': the risk class of the requested action. */
  actionClass?: MobileBrowserActionClass;
  /** Present when `kind` is 'browser': matched origin or target URL, for display. */
  site?: string;
}

export interface MobilePauseDto {
  isPaused: boolean;
  reasons: string[];
  pausedAt: number | null;
  lastChange: number;
}

/** Usage only: no account identifiers, probe errors, credentials, or spend data. */
export interface MobileQuotaWindowDto {
  id: string;
  label: string;
  percentUsed: number | null;
  resetsAt: number | null;
  exhausted: boolean;
}

export interface MobileQuotaProviderDto {
  provider: string;
  freshness: 'fresh' | 'stale' | 'unavailable';
  updatedAt: number | null;
  /** Expiry of the authoritative evidence, independent of the phone clock. */
  validUntil: number | null;
  exhausted: boolean;
  windows: MobileQuotaWindowDto[];
}

export interface MobileQuotaStateDto {
  serverTime: number;
  providers: MobileQuotaProviderDto[];
}

/** Safe automation schedule projection. Automation action/body data is never mobile-visible. */
export type MobileAutomationScheduleDto =
  | { type: 'cron'; expression: string; timezone: string }
  | { type: 'oneTime'; runAt: number; timezone?: string };

export interface MobileAutomationDto {
  id: string;
  name: string;
  schedule: MobileAutomationScheduleDto;
  enabled: boolean;
  nextRunAt: number | null;
  lastRun: {
    status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
    at: number;
  } | null;
  provider: string | null;
  model: string | null;
}

export interface MobileAutomationRunRequest {
  idempotencyKey: string;
}

export type MobileAutomationRunResponse =
  | { status: 'started' | 'queued'; runId: string }
  | { status: 'skipped'; runId?: string; reason: string };

export interface MobileSnapshot {
  hostName: string;
  serverTime: number;
  instances: MobileInstanceDto[];
  projects: MobileProjectDto[];
  prompts: MobilePromptDto[];
  pause: MobilePauseDto;
}

export type MobileServerEvent =
  | { type: 'pong'; data: { sentAt: number } }
  | { type: 'snapshot'; data: MobileSnapshot }
  | { type: 'instance-created'; data: MobileInstanceDto }
  | { type: 'instance-removed'; data: { instanceId: string } }
  | { type: 'instance-state'; data: MobileInstanceDto[] }
  | {
      type: 'instance-output';
      data: {
        instanceId: string;
        /** Legacy provider-event counter, retained for one release. */
        seq: number;
        /** Gateway-owned output-only counter used to detect missed WS frames. */
        streamSeq?: number;
        /** Absolute retained-buffer cursor shared with `?fromSeq=` replay. */
        bufferIndex?: number;
        /** Changes when the gateway detects that the live buffer was replaced. */
        bufferGeneration?: number;
        /** Changes whenever the gateway's process-local stream cursor state restarts. */
        cursorEpoch?: string;
        /** Provider adapter-listener generation, used to detect respawns. */
        adapterGeneration?: number;
        message: MobileMessageDto;
      };
    }
  | { type: 'permission-prompt'; data: MobilePromptDto }
  | { type: 'permission-cleared'; data: { requestId: string; instanceId?: string } }
  | { type: 'pause-state'; data: MobilePauseDto }
  | { type: 'quota-state'; data: MobileQuotaStateDto }
  | { type: 'loop-state'; data: { runId: string; run: MobileLoopRunDto | null } }
  | {
      type: 'plan-queue-state';
      data: { runId: string; itemId?: string; run: MobilePlanQueueRunDto | null };
    };

export type MobileClientEvent =
  | { type: 'view'; instanceId: string | null }
  | { type: 'ping'; sentAt: number };

export interface MobileAttachmentDto {
  name: string;
  type: string;
  size: number;
  data: string;
}

export interface MobileInputRequest {
  message: string;
  attachments?: MobileAttachmentDto[];
}

export interface MobileInputResponse {
  ok: true;
  queued?: boolean;
  queueId?: string;
  duplicate?: boolean;
}

/** Steer delegates active-turn/compaction decisions to the host instance manager. */
export type MobileSteerRequest = MobileInputRequest;
export interface MobileSteerResponse {
  ok: true;
}

export interface MobileCancelledInputDto {
  message: string;
  attachments?: MobileAttachmentDto[];
}

export interface MobileRespondRequest {
  requestId: string;
  decisionAction: 'allow' | 'deny';
  decisionScope?: 'once' | 'session' | 'always';
  response?: string;
}

export interface MobileCreateInstanceRequest {
  workingDirectory: string;
  provider?: string;
  model?: string;
  reasoningEffort?: MobileReasoningEffort;
  initialPrompt?: string;
  attachments?: MobileAttachmentDto[];
}

export interface MobileRenameRequest {
  displayName: string;
}

export interface MobileApnsTokenRequest {
  apnsToken: string;
}

export interface MobileRecentDirDto {
  path: string;
  displayName: string;
  lastAccessed: number;
  isPinned: boolean;
}

export interface MobileHistorySessionDto {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  workingDirectory: string;
  projectName: string;
  createdAt: number;
  lastActiveAt: number;
  archived: boolean;
  live: boolean;
  instanceId?: string;
}

/** Result of POST /api/history/:id/continue — a restored (new) instance. */
export interface MobileHistoryContinueResponse {
  instanceId: string;
  sessionId: string;
  historyThreadId: string;
  restoreMode: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
}

/** Result of POST /api/instances/:id/wake — revives a hibernated instance in place. */
export interface MobileWakeResponse {
  ok: true;
}

/* ------------------------------------------------------------------ */
/* M4.a Loop runs                                                      */
/* ------------------------------------------------------------------ */

export const MOBILE_LOOP_STATUSES = [
  'running',
  'paused',
  'completed',
  'completed-needs-review',
  'cancelled',
  'failed',
  'error',
  'no-progress',
  'cap-reached',
  'provider-limit',
  'cost-exceeded',
  'needs-human-arbitration',
  'reviewer-unreliable',
  'reviewer-unavailable',
  'builder-unreliable',
] as const;

export type MobileLoopStatus = (typeof MOBILE_LOOP_STATUSES)[number];

export type MobileLoopStage = 'PLAN' | 'REVIEW' | 'IMPLEMENT';

export type MobileLoopVerdict = 'OK' | 'WARN' | 'CRITICAL';

export interface MobileLoopIterationDto {
  seq: number;
  stage: MobileLoopStage;
  startedAt: number;
  endedAt: number | null;
  verdict: MobileLoopVerdict;
  testPassCount: number | null;
  testFailCount: number | null;
  filesChanged: number;
  /** Short output excerpt for the iteration card. */
  summary: string;
}

export interface MobileLoopRunDto {
  id: string;
  chatId: string;
  status: MobileLoopStatus;
  currentStage: MobileLoopStage;
  /** Completed iterations so far (the loop's own counter, not the cap). */
  iteration: number;
  maxIterations: number | null;
  startedAt: number;
  endedAt: number | null;
  totalTokens: number;
  totalCostCents: number;
  workspaceCwd: string;
  endReason: string | null;
  pausedForInput: boolean;
  lastIteration?: MobileLoopIterationDto;
}

export interface MobileLoopOutstandingItemDto {
  id: string;
  kind: 'needs-human' | 'open-question';
  text: string;
  status: 'open' | 'resolved' | 'dismissed';
  userResponse: string | null;
  recommendedAnswer: string | null;
}

export interface MobileLoopDetailDto {
  run: MobileLoopRunDto;
  iterations: MobileLoopIterationDto[];
  outstanding: MobileLoopOutstandingItemDto[];
}

export type MobileLoopControlResponse =
  | { ok: true; run: MobileLoopRunDto | null }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* M4.g Plan Queue                                                     */
/* ------------------------------------------------------------------ */

export const MOBILE_PLAN_QUEUE_ITEM_STATES = [
  'discovered',
  'needs-answer',
  'queued',
  'preparing',
  'working',
  'fixing',
  'awaiting-slot',
  'verifying',
  'landing',
  'landed',
  'parked',
  'skipped',
] as const;

export type MobilePlanQueueItemState =
  (typeof MOBILE_PLAN_QUEUE_ITEM_STATES)[number];

export const MOBILE_PLAN_QUEUE_RUN_STATUSES = [
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;

export type MobilePlanQueueRunStatus =
  (typeof MOBILE_PLAN_QUEUE_RUN_STATUSES)[number];

export interface MobilePlanQueueOptionDto {
  id: string;
  label: string;
}

export interface MobilePlanQueueQuestionDto {
  question: string;
  options: MobilePlanQueueOptionDto[];
}

/** Safe projection of a plan-queue item: no worktree or branch internals. */
export interface MobilePlanQueueItemDto {
  id: string;
  runId: string;
  /** Display name of the plan document. */
  title: string;
  documentPath: string;
  state: MobilePlanQueueItemState;
  round: number;
  question: MobilePlanQueueQuestionDto | null;
  answer: string | null;
  parkReason: string | null;
  detail: string | null;
  verdict: 'PASS' | 'FAIL' | null;
  workerInstanceId: string | null;
  updatedAt: number;
}

export interface MobilePlanQueueRunDto {
  id: string;
  kind: 'plans' | 'livetests';
  status: MobilePlanQueueRunStatus;
  workspaceCwd: string;
  startedAt: number;
  endedAt: number | null;
  workerProvider: string | null;
  workerModel: string | null;
  items: MobilePlanQueueItemDto[];
}

export interface MobilePlanQueueAnswerRequest {
  optionId: string;
}

/** Run-level controls only; item-level landing stays on the desktop. */
export interface MobilePlanQueueControlRequest {
  action: 'pause' | 'resume' | 'cancel';
}

export interface MobilePlanQueueDiffstatDto {
  diffstat: string;
}

/* ------------------------------------------------------------------ */
/* M4.h Doc review                                                     */
/* ------------------------------------------------------------------ */

export type MobileDocReviewStatus =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'rejected';

export interface MobileDocReviewOptionDto {
  id: string;
  label: string;
  /** false = radio (single choice), true = checkbox (multiple). */
  multi: boolean;
  isDefault: boolean;
}

export interface MobileDocReviewItemDto {
  id: string;
  title: string;
  decisionId: string | null;
  options: MobileDocReviewOptionDto[];
}

export interface MobileDocReviewSummaryDto {
  id: string;
  title: string;
  status: MobileDocReviewStatus;
  instanceId: string;
  createdAt: number;
  decidedAt: number | null;
}

export interface MobileDocReviewDetailDto {
  review: MobileDocReviewSummaryDto;
  items: MobileDocReviewItemDto[];
}

/** Mirrors the canonical DocReviewItemDecision feedback entry. */
export interface MobileDocReviewItemDecisionDto {
  itemId: string;
  title?: string;
  decisionId?: string | null;
  decision: 'approve' | 'reject' | null;
  comment?: string;
  choice?: string | null;
  choices?: string[];
}

/** Mirrors DocReviewSubmitDecisionPayload; must match the canonical block. */
export interface MobileDocReviewDecisionRequest {
  overall: 'approved' | 'changes_requested' | 'rejected';
  decisions: MobileDocReviewItemDecisionDto[];
  generalComment?: string;
}

export interface MobileDocReviewDecisionResponse {
  ok: true;
  status: MobileDocReviewStatus;
}

/* ------------------------------------------------------------------ */
/* M4.d Browser approval responses                                     */
/* ------------------------------------------------------------------ */

export interface MobileBrowserApprovalRespondRequest {
  decisionAction: 'allow' | 'deny';
  reason?: string;
}

export interface MobileBrowserApprovalRespondResponse {
  ok: true;
}
