/**
 * Permission Registry Types - Promise-based async permission resolution
 */

export interface PermissionRequest {
  id: string;
  instanceId: string;
  childId?: string;
  action: string;
  description: string;
  toolName?: string;
  details?: Record<string, unknown>;
  createdAt: number;
  timeoutMs: number;
}

/**
 * A pending {@link PermissionRequest} enriched for display in the renderer
 * approval surface (LT-095): the requesting instance's human-readable name so
 * "which app/instance is asking" doesn't require the renderer to already have
 * that instance loaded, plus a precomputed absolute deadline so the UI can
 * show/countdown a real clock time without re-deriving it from `createdAt` +
 * `timeoutMs` (which changes on `PermissionRegistry.extend()`).
 */
export interface PendingApprovalItem extends PermissionRequest {
  expiresAt: number;
  instanceLabel?: string;
  instanceProvider?: string;
}

export interface PermissionDecision {
  requestId: string;
  granted: boolean;
  decidedBy: 'user' | 'auto_approve' | 'timeout' | 'parent_deny';
  decidedAt: number;
}

export type OrchestrationRole =
  | 'parent_orchestrator'
  | 'worker'
  | 'reviewer'
  | 'verifier'
  | 'recovery_agent'
  | 'automation_runner';

export type RoleFilesystemWritePolicy = 'allow' | 'ask' | 'deny';

export type RoleToolCategory =
  | 'read'
  | 'analysis'
  | 'command_execution'
  | 'filesystem_write'
  | 'network'
  | 'webhook'
  | 'unknown';

export interface RoleCapabilityProfile {
  role: OrchestrationRole;
  canSpawnChildren: boolean;
  canRequestConsensus: boolean;
  canRequestUserAction: boolean;
  canCreateAutomations: boolean;
  canReportResult: boolean;
  canMessageChildren: boolean;
  canTerminateChildren: boolean;
  canCallTools: boolean;
  providerAllowlist: string[];
  modelAllowlist: string[];
  filesystemWrite: RoleFilesystemWritePolicy;
  commandCategories: RoleToolCategory[];
  networkAccess: boolean;
  webhookAccess: boolean;
  canUseYoloMode: boolean;
}

export interface RoleCapabilityDecision {
  allowed: boolean;
  reason?: string;
  profile: RoleCapabilityProfile;
  category?: RoleToolCategory;
}
