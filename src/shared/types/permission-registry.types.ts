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
