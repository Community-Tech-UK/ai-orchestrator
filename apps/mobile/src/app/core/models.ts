/**
 * Mirrors src/shared/types/mobile-gateway.types.ts in the main harness
 * repo. Kept as a local copy because this app is a standalone package, not a
 * monorepo workspace. If the gateway DTOs change, update both.
 */

export interface MobileInstanceDto {
  id: string;
  displayName: string;
  status: string;
  provider: string;
  model?: string;
  workingDirectory: string;
  projectName: string;
  createdAt: number;
  lastActivity: number;
  parentId?: string;
  pendingApprovalCount: number;
  hasUnreadCompletion: boolean;
  /** True when this live session has an active Loop Mode run. */
  isLooping?: boolean;
  contextPercentage?: number;
}

export interface MobileModelDto {
  id: string;
  name: string;
  tier: 'fast' | 'balanced' | 'powerful';
  pinned?: boolean;
  family?: string;
}

export type MobileModelCatalog = Record<string, MobileModelDto[]>;

export type MobileReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'workflow';

export interface MobileReasoningOption {
  id: 'default' | MobileReasoningEffort;
  label: string;
  description: string;
  isDefault?: boolean;
}

/**
 * Preview of what a new session will actually start with (resolved on the host).
 * Mirrors MobileSessionPlan in src/shared/types/mobile-gateway.types.ts.
 */
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
  lastActivity: number;
}

/** A transcript message as the phone renders it (subset of OutputMessage). */
export interface MobileMessageDto {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  hasAttachments?: boolean;
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

/** A pending "needs you" prompt — a deferred permission or an orchestration question. */
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

export interface MobileSnapshot {
  hostName: string;
  serverTime: number;
  instances: MobileInstanceDto[];
  projects: MobileProjectDto[];
  prompts: MobilePromptDto[];
  pause: MobilePauseDto;
}

export type MobileServerEvent =
  | { type: 'snapshot'; data: MobileSnapshot }
  | { type: 'instance-created'; data: MobileInstanceDto }
  | { type: 'instance-removed'; data: { instanceId: string } }
  | { type: 'instance-state'; data: MobileInstanceDto[] }
  | { type: 'instance-output'; data: { instanceId: string; seq: number; message: MobileMessageDto } }
  | { type: 'permission-prompt'; data: MobilePromptDto }
  | { type: 'permission-cleared'; data: { requestId: string; instanceId?: string } }
  | { type: 'pause-state'; data: MobilePauseDto };

/**
 * Control frames the phone sends UP the WebSocket. The active-view report lets
 * the gateway suppress the unread-completion dot for the conversation the user
 * is currently watching. `instanceId` is null when no conversation is open.
 */
export type MobileClientEvent =
  | { type: 'view'; instanceId: string | null };

/** Request bodies. */
export interface MobileAttachmentDto {
  name: string;
  type: string;
  size: number;
  data: string;
}

export interface MobileRespondRequest {
  requestId: string;
  decisionAction: 'allow' | 'deny';
  decisionScope?: 'once' | 'session' | 'always';
  /** select_option id or ask_questions JSON payload. */
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

export interface MobileRecentDirDto {
  path: string;
  displayName: string;
  lastAccessed: number;
  isPinned: boolean;
}

/** A persisted ("older") session for the History view. Mirrors the gateway DTO. */
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

/** A paired host as stored on the phone. */
export interface PairedHost {
  /** deviceId returned by /pair. */
  id: string;
  /** Display name (the host's machine name). */
  name: string;
  /** Tailnet IP or MagicDNS hostname. */
  host: string;
  port: number;
  /** Device bearer token (secret). */
  token: string;
  /** True → connect over wss/https (the gateway is serving TLS). */
  secure?: boolean;
  addedAt: number;
}

/** Connection payload encoded in the desktop pairing QR / connection code. */
export interface PairingPayload {
  v: number;
  host: string;
  port: number;
  pairingToken: string;
  /** True → the gateway serves TLS; pair + connect over https/wss. */
  secure?: boolean;
}
