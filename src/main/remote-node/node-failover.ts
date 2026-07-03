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

// Grace period before instances are announced as (recoverable) lost. This fires
// BEFORE the health monitor thresholds (DEGRADED_THRESHOLD 60s,
// DISCONNECT_THRESHOLD 90s in worker-node-health.ts) — see that file for the
// full timeline.
export const FAILOVER_GRACE_MS = 30_000;

/**
 * How long a node's instances are held as RECOVERABLE ('degraded') after a
 * disconnect before they are finally given up as 'failed'.
 *
 * A disconnected node's work is usually still running locally — a saturated link
 * or a suspended socket does not stop the CLIs on the node. Failing instances on
 * the old 30s schedule threw away healthy work (the 2026-07-03 incident). We now
 * keep them recoverable for a long window so a node that comes back within it is
 * reconciled (its instances restored) instead of declared dead. Only after this
 * hard timeout, when the node really is gone, do we mark them failed.
 */
export const FAILOVER_HARD_FAIL_MS = 10 * 60_000;

function isTerminalFailoverStatus(status: string): boolean {
  return status === 'failed' || status === 'terminated';
}

/**
 * How long the same failed-instance recovery offer is suppressed for a node.
 * A flapping node fires `node:connected` on every reconnect; without this the
 * identical "recovery available" set is re-broadcast on every flap cycle.
 */
export const RECOVERY_OFFER_DEBOUNCE_MS = 30_000;

interface RecoveryOfferRecord {
  key: string;
  at: number;
}

// Module-level dedupe state: last recovery offer signature + time per node.
const recentRecoveryOffers = new Map<string, RecoveryOfferRecord>();

/** Test hook: clear the late-reconnect recovery-offer debounce state. */
export function _resetRecoveryOfferDebounceForTesting(): void {
  recentRecoveryOffers.clear();
}

/**
 * Handles failover for all instances running on a disconnected worker node.
 *
 * Phase 1 (immediate): mark all affected instances 'degraded' (recoverable).
 * Phase 2 (grace, 30s): if still gone, announce a RECOVERABLE loss
 *   ('instance:remote-lost' with `recoverable: true`) but keep instances
 *   'degraded' — their work is likely still running on the node.
 * Phase 3 (hard timeout, 10min): if the node never came back, give up — mark
 *   instances 'failed' and emit a non-recoverable 'instance:remote-lost'.
 *
 * If the node reconnects at any point before the hard timeout, the timers are
 * cancelled and the instances are reconciled (original statuses restored); the
 * worker keeps streaming their live state over the re-established connection.
 */
export function handleNodeFailover(nodeId: string, instanceManager: InstanceManager): void {
  const registry = getWorkerNodeRegistry();

  const affected: { id: string; originalStatus: InstanceStatus }[] = instanceManager
    .getInstancesByNode(nodeId)
    .filter((inst) => !isTerminalFailoverStatus(inst.status))
    .map((inst) => ({
      id: inst.id,
      originalStatus: inst.status,
    }));

  if (affected.length === 0) {
    logger.info('Node failover: no instances affected', { nodeId });
    return;
  }

  logger.info('Node failover: marking instances degraded (recoverable)', {
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

  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let hardTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    if (hardTimer !== null) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
    registry.off('node:connected', onReconnect);
  };

  // Register the reconnect handler BEFORE starting the timers to avoid a race
  // where the node reconnects between timer creation and listener registration.
  function onReconnect(node: { id: string }): void {
    if (node.id !== nodeId) return;
    if (settled) return;
    settled = true;
    cleanup();

    logger.info('Node failover: node reconnected — reconciling instances', {
      nodeId,
      count: affected.length,
    });

    // Reconcile: restore original statuses for instances still alive. The worker
    // still owns these instances and resumes streaming their state over the new
    // connection, so this is an effective re-attach rather than a fresh spawn.
    for (const { id, originalStatus } of affected) {
      const inst = instanceManager.getInstance(id);
      if (inst && !isTerminalFailoverStatus(inst.status)) {
        instanceManager.updateInstanceStatus(id, originalStatus, {
          reason: 'worker-node-reconnected',
          nodeId,
        });
      }
    }
  }

  registry.on('node:connected', onReconnect);

  // Phase 2 (grace): announce a recoverable loss but keep instances degraded.
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (settled) return;

    const node = registry.getNode(nodeId);
    if (node?.status === 'connected') {
      // Reconnected without emitting node:connected during the window (race);
      // onReconnect will not have fired, so reconcile inline and settle.
      logger.info('Node failover: node reconnected before grace timer (race)', { nodeId });
      return;
    }

    logger.info('Node failover: grace expired — instances retained as recoverable', {
      nodeId,
      count: affected.length,
      hardFailInMs: FAILOVER_HARD_FAIL_MS,
    });

    for (const { id } of affected) {
      const inst = instanceManager.getInstance(id);
      if (inst && !isTerminalFailoverStatus(inst.status)) {
        // Instances stay 'degraded'; this is an informational, recoverable loss.
        instanceManager.emit('instance:remote-lost', { instanceId: id, nodeId, recoverable: true });
      }
    }
  }, FAILOVER_GRACE_MS);

  // Phase 3 (hard timeout): the node never returned — give up.
  hardTimer = setTimeout(() => {
    hardTimer = null;
    if (settled) return;
    settled = true;
    cleanup();

    const node = registry.getNode(nodeId);
    if (node?.status === 'connected') {
      logger.info('Node failover: node reconnected before hard timeout (race)', { nodeId });
      return;
    }

    logger.warn('Node failover: hard timeout expired — marking instances failed', {
      nodeId,
      count: affected.length,
    });

    for (const { id } of affected) {
      const inst = instanceManager.getInstance(id);
      if (inst && !isTerminalFailoverStatus(inst.status)) {
        instanceManager.updateInstanceStatus(id, 'failed', {
          reason: 'worker-node-hard-timeout',
          nodeId,
        });
        instanceManager.emit('instance:remote-lost', { instanceId: id, nodeId, recoverable: false });
      }
    }
  }, FAILOVER_HARD_FAIL_MS);
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
export function handleLateNodeReconnect(
  nodeId: string,
  instanceManager: InstanceManager,
  now: () => number = Date.now,
): void {

  const failedOnNode = instanceManager
    .getInstancesByNode(nodeId)
    .filter((inst) => inst.status === 'failed');

  if (failedOnNode.length === 0) {
    // Nothing to recover — forget any prior offer so a future failure is not
    // wrongly suppressed by a stale signature.
    recentRecoveryOffers.delete(nodeId);
    return;
  }

  // Debounce: suppress an identical recovery offer re-fired by a flapping node
  // within the debounce window. A changed failed-instance set always re-offers.
  const signature = failedOnNode
    .map((inst) => inst.id)
    .sort()
    .join(',');
  const nowMs = now();
  const previous = recentRecoveryOffers.get(nodeId);
  if (
    previous &&
    previous.key === signature &&
    nowMs - previous.at < RECOVERY_OFFER_DEBOUNCE_MS
  ) {
    logger.debug('Late node reconnect: duplicate recovery offer suppressed (flap debounce)', {
      nodeId,
      count: failedOnNode.length,
    });
    return;
  }
  recentRecoveryOffers.set(nodeId, { key: signature, at: nowMs });

  logger.info('Late node reconnect: found failed instances, signalling recovery available', {
    nodeId,
    count: failedOnNode.length,
    instanceIds: failedOnNode.map((i) => i.id),
  });

  for (const inst of failedOnNode) {
    // Failed is terminal in the lifecycle state machine. Late reconnect should
    // announce recovery availability without rejecting the node registration.
    try {
      instanceManager.emit('instance:remote-recovery-available', {
        instanceId: inst.id,
        nodeId,
      });
    } catch (error) {
      logger.warn('Late node reconnect: recovery event listener failed', {
        nodeId,
        instanceId: inst.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
