/**
 * Shared types for the Mobile Gateway — the small HTTP + WebSocket surface that
 * lets the companion phone app observe and control Harness instances
 * over a Tailscale tunnel. Lives in shared/ (like remote-observer.types.ts) so
 * both the Electron main process and any TypeScript client can reference it.
 *
 * Plan: docs/mobile-app/2026-05-30-mobile-control-app-plan.md
 */

/** A paired phone, as persisted by the gateway. The bearer `token` is secret. */
export interface MobileDevice {
  deviceId: string;
  label: string;
  /** Long-lived bearer token presented on every request. Secret. */
  token: string;
  createdAt: number;
  lastSeenAt: number;
  /** Epoch ms when the device token expires and the phone must re-pair. */
  expiresAt: number;
  /** APNs device token for push notifications (set after pairing, Phase 2). */
  apnsToken?: string;
}

/** Device view safe to surface in the desktop UI (no bearer token). */
export interface MobileDeviceSummary {
  deviceId: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  hasApnsToken: boolean;
}

/** One-time credential encoded into the pairing QR. */
export interface MobilePairingCredential {
  pairingToken: string;
  createdAt: number;
  expiresAt: number;
}

/** Request body for POST /pair. */
export interface MobilePairRequest {
  pairingToken: string;
  /** Human label for the device, e.g. "James's iPhone". */
  label?: string;
}

/** Response from POST /pair. */
export interface MobilePairResponse {
  deviceId: string;
  token: string;
  expiresAt: number;
  /** The host's display name (machine hostname) for the phone's host list. */
  hostName: string;
}

/** A single instance/agent as the phone sees it. */
export interface MobileInstanceDto {
  id: string;
  displayName: string;
  status: string;
  provider: string;
  model?: string;
  workingDirectory: string;
  /** basename of workingDirectory — the project label. */
  projectName: string;
  createdAt: number;
  lastActivity: number;
  parentId?: string;
  pendingApprovalCount: number;
  hasUnreadCompletion: boolean;
  /** 0–100 context window usage, when known. */
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

/** A project = a distinct workingDirectory with its sessions rolled up. */
export interface MobileProjectDto {
  /** Stable key (the workingDirectory, or '__no_workspace__'). */
  key: string;
  path: string;
  name: string;
  sessionCount: number;
  busyCount: number;
  pendingApprovalCount: number;
  lastActivity: number;
}

/**
 * A single transcript message as the phone renders it. Structurally a subset of
 * the main-process `OutputMessage` (instance.types.ts) so the gateway can pass
 * buffered messages straight through. Heavy fields (attachment data, raw
 * thinking) are deliberately omitted from the wire — `hasAttachments` flags
 * their presence for the UI.
 *
 * `seq` is the 0-based index of this message in the instance's outputBuffer at
 * the time of the replay response. Clients persist their last-seen `seq` and
 * pass it back as `?fromSeq=N` on reconnect to resume from where they left off.
 */
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

/**
 * Response envelope returned by `GET /api/instances/:id/messages?fromSeq=N`.
 * The plain array form (no envelope) is returned when `fromSeq` is absent for
 * backwards-compatibility.
 */
export interface MobileMessagesResumeDto {
  messages: MobileMessageDto[];
  meta: {
    /** The `fromSeq` value the client supplied. */
    fromSeq: number;
    /** Number of messages returned in this response. */
    returned: number;
    /**
     * True when the gap since `fromSeq` exceeded MESSAGE_REPLAY_LIMIT and the
     * client should request again (future pagination) or do a full re-sync.
     */
    hasMore: boolean;
    /** The highest `seq` in this response, or `fromSeq` when nothing was returned. */
    maxSeq: number;
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

/** A pending "needs you" prompt — a deferred permission or an orchestration question. */
export interface MobilePromptDto {
  /** Stable id (== requestId for permissions). */
  id: string;
  instanceId: string;
  requestId: string;
  kind: 'permission' | 'user-action';
  /** For user-action prompts: drives the phone UI layout. */
  requestType?: MobileUserActionRequestType;
  /** For permissions: the tool awaiting approval (e.g. "Bash"). */
  toolName?: string;
  /** For permissions: the tool arguments (e.g. the command). */
  toolInput?: Record<string, unknown>;
  title: string;
  message: string;
  /** For user-action prompts: selectable options with stable ids. */
  options?: MobilePromptOptionDto[];
  /** For ask_questions prompts: free-form questions to answer. */
  questions?: string[];
  createdAt: number;
}

/** Global pause state — mirrors the desktop PauseStatePayload. */
export interface MobilePauseDto {
  isPaused: boolean;
  reasons: string[];
  pausedAt: number | null;
  lastChange: number;
}

/** Snapshot sent to a phone on WebSocket connect (and on resync). */
export interface MobileSnapshot {
  hostName: string;
  serverTime: number;
  instances: MobileInstanceDto[];
  projects: MobileProjectDto[];
  /** Pending approval/question prompts at connect time. */
  prompts: MobilePromptDto[];
  /** Current global pause state at connect time. */
  pause: MobilePauseDto;
}

/** Messages pushed down the WebSocket to the phone. */
export type MobileServerEvent =
  | { type: 'snapshot'; data: MobileSnapshot }
  | { type: 'instance-created'; data: MobileInstanceDto }
  | { type: 'instance-removed'; data: { instanceId: string } }
  | { type: 'instance-state'; data: MobileInstanceDto[] }
  /** A live transcript frame for one instance. `seq` is the per-instance monotonic counter for gap detection. */
  | { type: 'instance-output'; data: { instanceId: string; seq: number; message: MobileMessageDto } }
  | { type: 'permission-prompt'; data: MobilePromptDto }
  | { type: 'permission-cleared'; data: { requestId: string; instanceId?: string } }
  | { type: 'pause-state'; data: MobilePauseDto };

/** Request body for POST /api/instances/:id/input. */
export interface MobileInputRequest {
  message: string;
  attachments?: MobileAttachmentDto[];
}

/** Mirrors the main-process FileAttachment (base64 data URL). */
export interface MobileAttachmentDto {
  name: string;
  type: string;
  size: number;
  data: string;
}

/** Request body for POST /api/instances/:id/respond (answer a permission prompt). */
export interface MobileRespondRequest {
  requestId: string;
  decisionAction: 'allow' | 'deny';
  decisionScope?: 'once' | 'session' | 'always';
  /**
   * Optional user-action payload:
   * - select_option: the chosen option id
   * - ask_questions: a JSON object string mapping question -> answer
   * - confirm / approve_action / switch_mode: usually omitted
   */
  response?: string;
}

/** Request body for POST /api/instances (create a new session). */
export interface MobileCreateInstanceRequest {
  workingDirectory: string;
  provider?: string;
  model?: string;
  initialPrompt?: string;
}

/** Request body for POST /api/instances/:id/rename. */
export interface MobileRenameRequest {
  displayName: string;
}

/** Request body for POST /api/devices/:id/apns-token. */
export interface MobileApnsTokenRequest {
  apnsToken: string;
}

/** A host recent directory offered to the phone's "new session" picker. */
export interface MobileRecentDirDto {
  path: string;
  displayName: string;
  lastAccessed: number;
  isPinned: boolean;
}

/**
 * A persisted ("older") session as the phone's History view sees it. Sourced
 * from the desktop ChatService (live + archived), so closed sessions that are
 * no longer in InstanceManager still appear. `live` is true when the chat is
 * still backed by a running instance; `archived` when it was explicitly closed.
 */
export interface MobileHistorySessionDto {
  /** Chat id (use to fetch the transcript via /api/history/:id/messages). */
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  workingDirectory: string;
  /** basename of workingDirectory — the project label. */
  projectName: string;
  createdAt: number;
  lastActiveAt: number;
  archived: boolean;
  live: boolean;
  /** If still live, the instance id so the phone can deep-link to the live session. */
  instanceId?: string;
}

/** Status of the gateway, surfaced to the desktop Settings → Mobile tab. */
export interface MobileGatewayStatus {
  running: boolean;
  host?: string;
  port?: number;
  /** Tailscale IPv4 if detected, else null. */
  tailscaleIp: string | null;
  /** True when the gateway is serving TLS (https/wss) from a configured cert. */
  secure?: boolean;
  /** Primary DNS name from the TLS cert (what the phone must connect to), when secure. */
  tlsHostname?: string | null;
  /** ws:// (or wss:// when secure) URL a phone would connect to over the tailnet, when running. */
  tailnetUrl?: string;
  startedAt?: number;
  connectedClientCount: number;
  pairedDeviceCount: number;
  /** True when APNs push is fully configured (key + key id + team id + bundle id). */
  pushConfigured: boolean;
}

/**
 * APNs credentials for direct-from-Mac push (§4.4 of the plan). Sourced from
 * settings; the gateway POSTs to Apple's HTTP/2 endpoint with a short-lived
 * ES256 JWT. Empty `keyP8` => push disabled (the gateway no-ops).
 */
export interface MobileApnsConfig {
  /** PEM contents of the APNs Auth Key (.p8). */
  keyP8: string;
  /** 10-char Key ID from the Apple Developer account. */
  keyId: string;
  /** 10-char Team ID. */
  teamId: string;
  /** App bundle id (APNs topic), e.g. com.shutupandshave.aiorchestrator. */
  bundleId: string;
  /** true → api.push.apple.com, false → api.sandbox.push.apple.com. */
  production: boolean;
}
