/**
 * Mirrors src/shared/types/mobile-gateway.types.ts in the main AI Orchestrator
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
  contextPercentage?: number;
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

/** A pending "needs you" prompt — a deferred permission or an orchestration question. */
export interface MobilePromptDto {
  id: string;
  instanceId: string;
  requestId: string;
  kind: 'permission' | 'user-action';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  title: string;
  message: string;
  options?: string[];
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
  response?: string;
}

export interface MobileCreateInstanceRequest {
  workingDirectory: string;
  provider?: string;
  model?: string;
  initialPrompt?: string;
}

export interface MobileRecentDirDto {
  path: string;
  displayName: string;
  lastAccessed: number;
  isPinned: boolean;
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
  addedAt: number;
}

/** Connection payload encoded in the desktop pairing QR / connection code. */
export interface PairingPayload {
  v: number;
  host: string;
  port: number;
  pairingToken: string;
}
