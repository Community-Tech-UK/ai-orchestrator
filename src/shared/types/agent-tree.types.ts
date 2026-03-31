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
  spawnConfig?: {
    task: string;
    model?: string;
    provider?: string;
    agentId?: string;
  };
  createdAt: number;
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

export const AGENT_TREE_SCHEMA_VERSION = 1;
