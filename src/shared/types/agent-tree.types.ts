/**
 * Agent Tree Types - Persist and restore full agent hierarchy trees
 *
 * Inspired by Codex's rollout persistence where the entire agent tree
 * is persisted and reconstructed via BFS on resume.
 */

export interface AgentTreeNode {
  instanceId: string;
  displayName: string;
  parentId: string | null;
  childrenIds: string[];
  depth: number;
  status: string;
  provider: string;
  model?: string;
  workingDirectory: string;
  agentId?: string;
  sessionId: string;
  hasResult: boolean;
  role?: string;
  spawnPromptHash?: string;
  statusTimeline: Array<{
    status: string;
    timestamp: number;
  }>;
  heartbeatAt?: number;
  lastActivityAt: number;
  resultId?: string;
  artifactCount?: number;
  routing?: {
    requestedProvider?: string;
    requestedModel?: string;
    actualProvider?: string;
    actualModel?: string;
    routingSource?: string;
    reason?: string;
  };
  spawnConfig?: {
    task: string;
    model?: string;
    provider?: string;
    agentId?: string;
  };
  createdAt: number;
}

export interface ChildDiagnosticOutputLine {
  type: string;
  content: string;
  timestamp: number;
}

export interface ChildDiagnosticEvent {
  type: string;
  summary: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ChildDiagnosticArtifactsSummary {
  resultId?: string;
  success?: boolean;
  artifactCount: number;
  artifactTypes: string[];
  hasMoreDetails: boolean;
}

export interface ChildDiagnosticBundle {
  /** Backward-compatible alias for childInstanceId. */
  childId: string;
  /** Backward-compatible alias for parentInstanceId. */
  parentId: string;
  parentInstanceId: string;
  childInstanceId: string;
  status: string;
  provider: string;
  model?: string;
  workingDirectory: string;
  /** Backward-compatible alias for spawnTaskSummary. */
  task?: string;
  spawnTaskSummary?: string;
  spawnPromptHash?: string;
  resultId?: string;
  routing?: AgentTreeNode['routing'];
  statusTimeline: AgentTreeNode['statusTimeline'];
  lastHeartbeatAt?: number;
  recentEvents: ChildDiagnosticEvent[];
  /** Backward-compatible alias for recentOutputTail. */
  recentOutput: ChildDiagnosticOutputLine[];
  recentOutputTail: ChildDiagnosticOutputLine[];
  artifactsSummary: ChildDiagnosticArtifactsSummary;
  timeoutReason?: string;
  capturedAt: number;
}

export interface SpawnEdge {
  parentId: string;
  childId: string;
  timestamp: number;
  task: string;
}

export interface AgentTreeSnapshot {
  id: string;
  rootId: string;
  nodes: AgentTreeNode[];
  edges: SpawnEdge[];
  schemaVersion: number;
  timestamp: number;
  workingDirectory: string;
  totalInstances: number;
  totalTokensUsed: number;
}

export interface TreeRestoreOptions {
  restoreChildren: boolean;
  maxDepth?: number;
  resumeSessions: boolean;
  workingDirectory?: string;
}

export const AGENT_TREE_SCHEMA_VERSION = 2;
