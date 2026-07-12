/**
 * Remote-node access seams for the auxiliary LLM service.
 *
 * These are lazy-required (not top-level imported) because worker-node-connection
 * and service-rpc-client transitively import electron via remote-auth →
 * settings-manager, which crashes in worker_thread contexts. The indirection
 * also gives tests an injection point (vitest cannot mock a native require()).
 * See src/main/instance/__tests__/context-worker-import-isolation.spec.ts.
 */

import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';

function defaultIsNodeConnected(nodeId: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeConnectionServer } = require('../remote-node/worker-node-connection') as typeof import('../remote-node/worker-node-connection');
    return getWorkerNodeConnectionServer().isNodeConnected(nodeId);
  } catch {
    return false;
  }
}

async function defaultSendServiceRpc<T>(
  nodeId: string,
  method: string,
  params: unknown,
  timeoutMs: number,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sendServiceRpc } = require('../remote-node/service-rpc-client') as typeof import('../remote-node/service-rpc-client');
  return sendServiceRpc<T>(nodeId, method, params, timeoutMs);
}

/**
 * Connected worker nodes (with their reported capabilities). Returns an empty
 * list if the registry cannot be loaded (e.g. worker context).
 */
function defaultConnectedWorkerNodes(): WorkerNodeInfo[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWorkerNodeRegistry } = require('../remote-node/worker-node-registry') as typeof import('../remote-node/worker-node-registry');
    return getWorkerNodeRegistry().getAllNodes().filter((n) => n.status === 'connected');
  } catch {
    return [];
  }
}

/**
 * Mutable hook object consumed by AuxiliaryLlmService. Production code always
 * reads through this object so the test setters below take effect.
 */
export const auxiliaryRemoteHooks: {
  isNodeConnected: (nodeId: string) => boolean;
  sendServiceRpc: <T>(nodeId: string, method: string, params: unknown, timeoutMs: number) => Promise<T>;
  connectedWorkerNodes: () => WorkerNodeInfo[];
} = {
  isNodeConnected: defaultIsNodeConnected,
  sendServiceRpc: defaultSendServiceRpc,
  connectedWorkerNodes: defaultConnectedWorkerNodes,
};

/** Test-only: override the remote-node access seams. */
export function __setAuxiliaryRemoteHooksForTesting(hooks: {
  isNodeConnected?: (nodeId: string) => boolean;
  sendServiceRpc?: <T>(nodeId: string, method: string, params: unknown, timeoutMs: number) => Promise<T>;
  connectedWorkerNodes?: () => WorkerNodeInfo[];
}): void {
  if (hooks.isNodeConnected) auxiliaryRemoteHooks.isNodeConnected = hooks.isNodeConnected;
  if (hooks.sendServiceRpc) auxiliaryRemoteHooks.sendServiceRpc = hooks.sendServiceRpc;
  if (hooks.connectedWorkerNodes) auxiliaryRemoteHooks.connectedWorkerNodes = hooks.connectedWorkerNodes;
}

/** Test-only: restore the production lazy-require seams. */
export function __resetAuxiliaryRemoteHooksForTesting(): void {
  auxiliaryRemoteHooks.isNodeConnected = defaultIsNodeConnected;
  auxiliaryRemoteHooks.sendServiceRpc = defaultSendServiceRpc;
  auxiliaryRemoteHooks.connectedWorkerNodes = defaultConnectedWorkerNodes;
}
