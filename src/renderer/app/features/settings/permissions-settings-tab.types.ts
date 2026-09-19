/**
 * Data shapes for the Permissions settings tab (Requests, Rules, Audit,
 * Insights). Split out of `permissions-settings-tab.component.ts` to keep
 * that file focused on behaviour rather than the preload/IPC response
 * shapes it consumes.
 */

/** The four task-based views the Permissions tab splits into. */
export type PermissionsSection = 'requests' | 'rules' | 'audit' | 'insights';

export interface PermissionsApi {
  permissionGetPendingBatch?: () => Promise<{ success: boolean; data?: { requests?: unknown[] } }>;
  permissionGetLearnedPatterns?: () => Promise<{ success: boolean; data?: LearnedPattern[] }>;
  permissionGetStats?: () => Promise<{ success: boolean; data?: Partial<PermissionStats> }>;
  permissionRecordBatchDecision?: (params: { action: string; scope: string }) => Promise<{ success: boolean }>;
  permissionRecordDecision?: (params: { requestId: string; action: string; scope: string }) => Promise<{ success: boolean }>;
  permissionApprovePattern?: (params: { patternId: string }) => Promise<{ success: boolean }>;
  permissionRejectPattern?: (params: { patternId: string }) => Promise<{ success: boolean }>;
}

/** Helper to access the preload-exposed API from `window`. */
export const getApi = () => (window as unknown as { electronAPI?: PermissionsApi }).electronAPI;

export interface PendingPermission {
  id: string;
  scope: string;
  resource: string;
  toolName?: string;
  timestamp: number;
}

export interface LearnedPattern {
  id: string;
  scope: string;
  pattern: string;
  recommendedAction: 'allow' | 'deny';
  confidence: number;
  sampleCount: number;
  lastUpdated: number;
  approved: boolean;
}

export interface PermissionStats {
  totalPatterns: number;
  approvedPatterns: number;
  pendingPatterns: number;
  suggestionsMade: number;
  suggestionsAccepted: number;
  accuracyRate: number;
  ruleSetCount: number;
  totalRules: number;
  cacheSize: number;
  cacheHitRate: number;
}

export interface PermissionDecisionAuditRecord {
  instanceId: string;
  scope: string;
  resource: string;
  action: 'allow' | 'deny' | 'ask';
  decidedBy?: string;
  ruleId?: string;
  reason?: string;
  toolName?: string;
  isCached?: boolean;
  decidedAt: string;
}

export interface PermissionDenialAuditRecord {
  timestamp: number;
  instanceId: string;
  toolName: string;
  behavior: 'allow' | 'warn' | 'deny';
  reason: string;
}

export interface PermissionAuditResponse {
  decisions?: PermissionDecisionAuditRecord[];
  denials?: PermissionDenialAuditRecord[];
}
