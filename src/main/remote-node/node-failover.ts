/**
 * Node Failover Handler
 *
 * Manages instance cleanup when a worker node disconnects. Uses a grace
 * period to allow brief reconnections before marking instances as failed.
 */

import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getInstanceManager } from '../instance/instance-manager';

const logger = getLogger('NodeFailover');

export const FAILOVER_GRACE_MS = 30_000;

/**
 * Handles failover for all instances running on a disconnected worker node.
 *
 * Phase 1 (immediate): Marks all affected instances as 'degraded'.
 * Phase 2 (after grace period): If the node has not reconnected, marks all
 *   instances as 'failed' and emits 'instance:remote-lost' for each.
 *
 * If the node reconnects during the grace period, the timer is cancelled and
 * original instance statuses are restored.
 */
export function handleNodeFailover(nodeId: string): void {
  const registry = getWorkerNodeRegistry();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instanceManager = getInstanceManager() as any;

  const affected: { id: string; originalStatus: string }[] = instanceManager
    .getInstancesByNode(nodeId)
    .map((inst: { id: string; status: string }) => ({
      id: inst.id,
      originalStatus: inst.status,
    }));

  if (affected.length === 0) {
    logger.info('Node failover: no instances affected', { nodeId });
    return;
  }

  logger.info('Node failover: marking instances degraded', {
    nodeId,
    count: affected.length,
  });

  // Phase 1: immediately degrade all affected instances
  for (const { id } of affected) {
    instanceManager.updateInstanceStatus(id, 'degraded', {
      reason: 'worker-node-disconnected',
      nodeId,
    });
  }

  // Phase 2: set up grace period timer
  let gracePeriodTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    gracePeriodTimer = null;
    registry.off('node:connected', onReconnect);

    // Check if the node came back
    const node = registry.getNode(nodeId);
    if (node?.status === 'connected') {
      logger.info('Node failover: node reconnected before grace period timer fired (race)', {
        nodeId,
      });
      return;
    }

    logger.info('Node failover: grace period expired, marking instances failed', {
      nodeId,
      count: affected.length,
    });

    for (const { id } of affected) {
      instanceManager.updateInstanceStatus(id, 'failed', {
        reason: 'worker-node-disconnected',
        nodeId,
      });
      instanceManager.emit('instance:remote-lost', { instanceId: id, nodeId });
    }
  }, FAILOVER_GRACE_MS);

  // Reconnect handler: if the node comes back during the grace period
  const onReconnect = (node: { id: string }) => {
    if (node.id !== nodeId) {
      return;
    }

    logger.info('Node failover: node reconnected during grace period, restoring statuses', {
      nodeId,
      count: affected.length,
    });

    if (gracePeriodTimer !== null) {
      clearTimeout(gracePeriodTimer);
      gracePeriodTimer = null;
    }
    registry.off('node:connected', onReconnect);

    for (const { id, originalStatus } of affected) {
      instanceManager.updateInstanceStatus(id, originalStatus, {
        reason: 'worker-node-reconnected',
        nodeId,
      });
    }
  };

  registry.on('node:connected', onReconnect);

  // Safety cleanup: remove the reconnect listener after grace period + 1s
  setTimeout(() => {
    registry.off('node:connected', onReconnect);
  }, FAILOVER_GRACE_MS + 1_000);
}
