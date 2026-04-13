/**
 * Node Failover Handler
 *
 * Manages instance cleanup when a worker node disconnects. Uses a grace
 * period to allow brief reconnections before marking instances as failed.
 */

import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from './worker-node-registry';
import type { InstanceManager } from '../instance/instance-manager';
import type { InstanceStatus } from '../../shared/types/instance.types';

const logger = getLogger('NodeFailover');

// Grace period before marking instances as failed. This fires BEFORE the
// health monitor thresholds (DEGRADED_THRESHOLD 60s, DISCONNECT_THRESHOLD 90s
// in worker-node-health.ts) — see that file for the full timeline.
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
export function handleNodeFailover(nodeId: string, instanceManager: InstanceManager): void {
  const registry = getWorkerNodeRegistry();

  const affected: { id: string; originalStatus: string }[] = instanceManager
    .getInstancesByNode(nodeId)
    .map((inst) => ({
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

  // Register the reconnect handler BEFORE starting the grace period timer
  // to avoid a race where the node reconnects between timer creation and
  // listener registration.
  let cancelled = false;

  const onReconnect = (node: { id: string }) => {
    if (node.id !== nodeId) return;
    if (cancelled) return;
    cancelled = true;

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
      // Verify instance still exists before restoring
      const inst = instanceManager.getInstance(id);
      if (inst) {
        instanceManager.updateInstanceStatus(id, originalStatus as InstanceStatus, {
          reason: 'worker-node-reconnected',
          nodeId,
        });
      }
    }
  };

  registry.on('node:connected', onReconnect);

  // Phase 2: set up grace period timer (AFTER listener is registered)
  let gracePeriodTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    gracePeriodTimer = null;
    if (cancelled) return; // Reconnect handler already ran
    cancelled = true;
    registry.off('node:connected', onReconnect);

    // Double-check the node hasn't reconnected
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
      // Verify instance still exists before updating
      const inst = instanceManager.getInstance(id);
      if (inst) {
        instanceManager.updateInstanceStatus(id, 'failed', {
          reason: 'worker-node-disconnected',
          nodeId,
        });
        instanceManager.emit('instance:remote-lost', { instanceId: id, nodeId });
      }
    }
  }, FAILOVER_GRACE_MS);

  // Safety cleanup: remove the reconnect listener after grace period + buffer
  setTimeout(() => {
    registry.off('node:connected', onReconnect);
  }, FAILOVER_GRACE_MS + 5_000);
}

/**
 * Handle late reconnection of a worker node (after the grace period has expired).
 *
 * When a node reboots, the grace period (30s) expires long before the machine
 * comes back. This handler runs on `node:connected` and checks for any instances
 * that were left in 'failed' state due to that node's earlier disconnection.
 * It emits 'instance:remote-recovery-available' so the UI can offer the user
 * a restart/resume action.
 *
 * Call this from the global `node:connected` listener in index.ts.
 */
export function handleLateNodeReconnect(nodeId: string, instanceManager: InstanceManager): void {

  const failedOnNode = instanceManager
    .getInstancesByNode(nodeId)
    .filter((inst) => inst.status === 'failed');

  if (failedOnNode.length === 0) return;

  logger.info('Late node reconnect: found failed instances, signalling recovery available', {
    nodeId,
    count: failedOnNode.length,
    instanceIds: failedOnNode.map((i) => i.id),
  });

  for (const inst of failedOnNode) {
    // Transition from failed → idle so the user can interact again.
    // The CLI process on the remote node is gone (it rebooted), so the instance
    // will need a fresh spawn when the user next sends a message — but at least
    // the session state (displayName, output history, continuity data) is preserved.
    instanceManager.updateInstanceStatus(inst.id, 'idle', {
      reason: 'worker-node-late-reconnected',
      nodeId,
    });

    instanceManager.emit('instance:remote-recovery-available', {
      instanceId: inst.id,
      nodeId,
    });
  }
}
