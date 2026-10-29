import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';

const logger = getLogger('WorkerNodeHealth');

const CHECK_INTERVAL_MS = 10_000;
// Degraded threshold must be significantly longer than the RPC timeout (30s)
// to avoid false positives during legitimate slow operations. Nodes that
// miss 6 consecutive health checks (60s) are marked degraded.
const DEGRADED_THRESHOLD_MS = 60_000;
// Disconnect threshold gives additional grace beyond degraded before
// removing the node entirely.
//
// Timeline relationship with node-failover.ts:
//   FAILOVER_GRACE_MS (30s)  — instances marked failed if node doesn't return
//   DEGRADED_THRESHOLD (60s) — health monitor marks node degraded
//   DISCONNECT_THRESHOLD (90s) — health monitor deregisters node
//
// Failover fires first (triggered by WS disconnect), so instances are already
// handled before the health monitor removes the node entry. This ordering is
// intentional — the health monitor acts as a backstop cleanup.
const DISCONNECT_THRESHOLD_MS = 90_000;
// A check this late means the coordinator itself was not running: its main
// event loop was blocked, or the Mac was asleep. Heartbeats that arrived in
// the meantime can still be unread in the socket (an overdue timer can run
// before socket I/O when the loop resumes), so the silence is the
// coordinator's, not the node's. On 2026-10-28 three main-process stalls of
// 82-134 s deregistered every connected worker at once this way. After such a
// gap the heartbeat window restarts from the moment the coordinator resumed.
// Trade-off: a coordinator that stalled 10 s+ more often than every 90 s would
// never deregister a dead node whose socket stayed open; a closed socket is
// still handled at once by the connection server.
const LATE_CHECK_MS = CHECK_INTERVAL_MS * 2;

export class WorkerNodeHealth {
  private static instance: WorkerNodeHealth | null = null;

  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private pingInFlight = new Set<string>();
  private lastCheckAt = new Map<string, number>();
  /** When the coordinator last resumed from a stall, per monitored node. */
  private resumedAt = new Map<string, number>();

  static getInstance(): WorkerNodeHealth {
    if (!this.instance) {
      this.instance = new WorkerNodeHealth();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stopAll();
    }
    (this.instance as unknown) = undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  startMonitoring(nodeId: string): void {
    if (this.intervals.has(nodeId)) return;

    const handle = setInterval(() => {
      this.checkHealth(nodeId);
    }, CHECK_INTERVAL_MS);

    this.intervals.set(nodeId, handle);
    this.lastCheckAt.set(nodeId, Date.now());
    logger.info('Health monitoring started', { nodeId });
  }

  stopMonitoring(nodeId: string): void {
    const handle = this.intervals.get(nodeId);
    if (handle === undefined) return;
    clearInterval(handle);
    this.intervals.delete(nodeId);
    this.pingInFlight.delete(nodeId);
    this.lastCheckAt.delete(nodeId);
    this.resumedAt.delete(nodeId);
    logger.info('Health monitoring stopped', { nodeId });
  }

  isMonitoring(nodeId: string): boolean {
    return this.intervals.has(nodeId);
  }

  stopAll(): void {
    // Snapshot: stopMonitoring() deletes from this.intervals while we iterate.
    for (const nodeId of Array.from(this.intervals.keys())) {
      this.stopMonitoring(nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private checkHealth(nodeId: string): void {
    const registry = getWorkerNodeRegistry();
    const node = registry.getNode(nodeId);

    if (!node) {
      // Node was removed externally — stop monitoring
      this.stopMonitoring(nodeId);
      return;
    }

    const now = Date.now();
    const sinceLastCheck = now - (this.lastCheckAt.get(nodeId) ?? now);
    this.lastCheckAt.set(nodeId, now);
    if (sinceLastCheck >= LATE_CHECK_MS) {
      this.resumedAt.set(nodeId, now);
      logger.info('Coordinator was not running; restarting the heartbeat window', {
        nodeId,
        sinceLastCheck,
      });
    }

    const lastHeardAt = Math.max(node.lastHeartbeat ?? node.connectedAt ?? 0, this.resumedAt.get(nodeId) ?? 0);
    const timeSinceHeartbeat = now - lastHeardAt;

    if (timeSinceHeartbeat >= DISCONNECT_THRESHOLD_MS) {
      logger.warn('Node exceeded disconnect threshold, deregistering', {
        nodeId,
        timeSinceHeartbeat,
      });
      this.stopMonitoring(nodeId);
      registry.deregisterNode(nodeId);
      // Close the socket too. A worker whose process was suspended (machine
      // sleep, console QuickEdit freeze) keeps its socket open and resumes
      // heartbeating into a registry that no longer knows it — and its
      // reconnect logic only fires on socket close. Without this it zombies
      // until manually restarted.
      getWorkerNodeConnectionServer().disconnectNode(nodeId, 'Heartbeat timeout — re-register required');
    } else if (timeSinceHeartbeat >= DEGRADED_THRESHOLD_MS && node.status === 'connected') {
      logger.warn('Node exceeded degraded threshold', { nodeId, timeSinceHeartbeat });
      registry.updateNodeMetrics(nodeId, { status: 'degraded' });
    }

    this.measureLatency(nodeId);
  }

  private measureLatency(nodeId: string): void {
    if (this.pingInFlight.has(nodeId)) {
      return;
    }

    this.pingInFlight.add(nodeId);
    const startedAt = Date.now();

    void getWorkerNodeConnectionServer()
      .sendRpc<{ pong: number }>(nodeId, COORDINATOR_TO_NODE.NODE_PING)
      .then(() => {
        const latencyMs = Math.max(0, Date.now() - startedAt);
        const registry = getWorkerNodeRegistry();
        if (registry.getNode(nodeId)) {
          registry.updateNodeMetrics(nodeId, { latencyMs });
        }
      })
      .catch((error) => {
        logger.debug('Worker node ping failed', {
          nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pingInFlight.delete(nodeId);
      });
  }
}

export function getWorkerNodeHealth(): WorkerNodeHealth {
  return WorkerNodeHealth.getInstance();
}
