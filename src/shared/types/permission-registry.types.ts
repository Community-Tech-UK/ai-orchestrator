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
