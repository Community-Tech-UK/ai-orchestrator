/**
 * Orchestration Snapshot Types - Snapshot-subscription model for UI state
 */

export interface OrchestrationSnapshot {
  activeChildren: Record<string, ChildSnapshot[]>;
  activeDebates: DebateSnapshot[];
  activeVerifications: VerificationSnapshot[];
  pendingActions: PendingActionSnapshot[];
  pendingPermissions: PendingPermissionSnapshot[];
  lastUpdated: number;
}

export interface ChildSnapshot {
  childId: string;
  parentId: string;
  name: string;
  status: string;
  createdAt: number;
  tokensUsed: number;
  currentActivity?: string;
}

export interface DebateSnapshot {
  debateId: string;
  instanceId: string;
  currentRound: number;
  totalRounds: number;
  agentCount: number;
  status: 'active' | 'synthesizing' | 'completed';
}

export interface VerificationSnapshot {
  verificationId: string;
  instanceId: string;
  agentCount: number;
  responsesCollected: number;
  status: 'collecting' | 'analyzing' | 'completed';
}

export interface PendingActionSnapshot {
  requestId: string;
  instanceId: string;
  requestType: string;
  title: string;
  createdAt: number;
}

export interface PendingPermissionSnapshot {
  requestId: string;
  instanceId: string;
  action: string;
  description: string;
  createdAt: number;
}
