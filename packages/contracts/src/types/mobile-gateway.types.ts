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

export interface MobilePromptDto {
  id: string;
  instanceId: string;
  requestId: string;
  kind: 'permission' | 'user-action';
  requestType?: MobileUserActionRequestType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  title: string;
  message: string;
  options?: MobilePromptOptionDto[];
  questions?: string[];
  createdAt: number;
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
  | { type: 'quota-state'; data: MobileQuotaStateDto };

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
