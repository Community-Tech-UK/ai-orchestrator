/**
 * Shared types for the Mobile Gateway — the small HTTP + WebSocket surface that
 * lets the companion phone app observe and control AI Orchestrator instances
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

/** Snapshot sent to a phone on WebSocket connect (and on resync). */
export interface MobileSnapshot {
  hostName: string;
  serverTime: number;
  instances: MobileInstanceDto[];
  projects: MobileProjectDto[];
}

/** Messages pushed down the WebSocket to the phone. */
export type MobileServerEvent =
  | { type: 'snapshot'; data: MobileSnapshot }
  | { type: 'instance-created'; data: MobileInstanceDto }
  | { type: 'instance-removed'; data: { instanceId: string } }
  | { type: 'instance-state'; data: MobileInstanceDto[] };

/** Status of the gateway, surfaced to the desktop Settings → Mobile tab. */
export interface MobileGatewayStatus {
  running: boolean;
  host?: string;
  port?: number;
  /** Tailscale IPv4 if detected, else null. */
  tailscaleIp: string | null;
  /** ws:// URL a phone would connect to over the tailnet, when running. */
  tailnetUrl?: string;
  startedAt?: number;
  connectedClientCount: number;
  pairedDeviceCount: number;
}
