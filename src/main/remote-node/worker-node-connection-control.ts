import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { WorkerNodeConnectionServer } from './worker-node-connection';
import { resolveWorkerNodeTarget, type WorkerNodeRegistry } from './worker-node-registry';

/**
 * Injected rather than imported so callers (the orchestrator-tools step) pass
 * the same singletons they already resolve, and their test mocks apply.
 */
export interface WorkerNodeConnectionControlDeps {
  server: Pick<WorkerNodeConnectionServer, 'getConnectedNodeIds' | 'isNodeConnected' | 'resetNodeConnection'>;
  registry: Pick<WorkerNodeRegistry, 'getAllNodes'>;
}

/** Resolve a node name/id/capability to a connected (connected/degraded) node or throw an actionable error. */
export function resolveConnectedWorkerNode(deps: WorkerNodeConnectionControlDeps, requested: string): WorkerNodeInfo {
  const connectedIds = new Set(deps.server.getConnectedNodeIds());
  const connectedNodes = deps.registry.getAllNodes().filter(
    (node) => connectedIds.has(node.id) && (node.status === 'connected' || node.status === 'degraded'),
  );
  const resolved = resolveWorkerNodeTarget(requested, connectedNodes);
  if ('error' in resolved) throw new Error(resolved.error);
  const node = connectedNodes.find((candidate) => candidate.id === resolved.nodeId);
  if (!node || !deps.server.isNodeConnected(node.id)) {
    throw new Error(`Node not connected: ${requested}`);
  }
  return node;
}

/**
 * Non-revoking connection reset for `reset_node_connection`. Exact id/name
 * only: a disruptive action must never land on a capability-tag match.
 */
export function resetWorkerNodeConnection(
  deps: WorkerNodeConnectionControlDeps,
  requested: string,
  reason: string,
): { nodeId: string; nodeName: string; reset: boolean } {
  const want = requested.trim().toLowerCase();
  const node = deps.registry.getAllNodes().find(
    (candidate) => candidate.id.toLowerCase() === want || candidate.name?.toLowerCase() === want,
  );
  if (!node) {
    throw new Error(`No worker node with name or id "${requested}"; call list_remote_nodes for exact names.`);
  }
  const reset = deps.server.resetNodeConnection(node.id, reason);
  return { nodeId: node.id, nodeName: node.name, reset };
}
