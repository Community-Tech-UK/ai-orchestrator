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

export interface MobileSnapshot {
  hostName: string;
  serverTime: number;
  instances: MobileInstanceDto[];
  projects: MobileProjectDto[];
}

export type MobileServerEvent =
  | { type: 'snapshot'; data: MobileSnapshot }
  | { type: 'instance-created'; data: MobileInstanceDto }
  | { type: 'instance-removed'; data: { instanceId: string } }
  | { type: 'instance-state'; data: MobileInstanceDto[] };

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
