import { getLogger } from '../logging/logger';
import { getWorkerNodeRegistry } from './worker-node-registry';

const logger = getLogger('WorkerNodeHealth');

const CHECK_INTERVAL_MS = 10_000;
const DEGRADED_THRESHOLD_MS = 30_000;
const DISCONNECT_THRESHOLD_MS = 50_000;

export class WorkerNodeHealth {
  private static instance: WorkerNodeHealth;

  private intervals = new Map<string, ReturnType<typeof setInterval>>();

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
    logger.info('Health monitoring started', { nodeId });
  }

  stopMonitoring(nodeId: string): void {
    const handle = this.intervals.get(nodeId);
    if (handle === undefined) return;
    clearInterval(handle);
    this.intervals.delete(nodeId);
    logger.info('Health monitoring stopped', { nodeId });
  }

  isMonitoring(nodeId: string): boolean {
    return this.intervals.has(nodeId);
  }

  stopAll(): void {
    for (const nodeId of [...this.intervals.keys()]) {
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
    const timeSinceHeartbeat = now - (node.lastHeartbeat ?? node.connectedAt ?? 0);

    if (timeSinceHeartbeat >= DISCONNECT_THRESHOLD_MS) {
      logger.warn('Node exceeded disconnect threshold, deregistering', {
        nodeId,
        timeSinceHeartbeat,
      });
      this.stopMonitoring(nodeId);
      registry.deregisterNode(nodeId);
    } else if (timeSinceHeartbeat >= DEGRADED_THRESHOLD_MS && node.status === 'connected') {
      logger.warn('Node exceeded degraded threshold', { nodeId, timeSinceHeartbeat });
      registry.updateNodeMetrics(nodeId, { status: 'degraded' });
    }
  }
}

export function getWorkerNodeHealth(): WorkerNodeHealth {
  return WorkerNodeHealth.getInstance();
}
