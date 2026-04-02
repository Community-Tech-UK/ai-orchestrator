import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  WorkerNodeInfo,
  WorkerNodeCapabilities,
  NodePlacementPrefs,
} from '../../shared/types/worker-node.types';

const logger = getLogger('WorkerNodeRegistry');

export class WorkerNodeRegistry extends EventEmitter {
  private nodes = new Map<string, WorkerNodeInfo>();

  private static instance: WorkerNodeRegistry;

  static getInstance(): WorkerNodeRegistry {
    if (!this.instance) {
      this.instance = new WorkerNodeRegistry();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  private constructor() {
    super();
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  registerNode(info: WorkerNodeInfo): void {
    this.nodes.set(info.id, { ...info });
    logger.info('Node registered', { nodeId: info.id, address: info.address });
    this.emit('node:connected', this.nodes.get(info.id)!);
  }

  deregisterNode(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.nodes.delete(nodeId);
    logger.info('Node deregistered', { nodeId });
    this.emit('node:disconnected', node);
  }

  getNode(nodeId: string): WorkerNodeInfo | undefined {
    return this.nodes.get(nodeId);
  }

  getAllNodes(): WorkerNodeInfo[] {
    return [...this.nodes.values()];
  }

  getHealthyNodes(): WorkerNodeInfo[] {
    return [...this.nodes.values()].filter(n => n.status === 'connected');
  }

  // ---------------------------------------------------------------------------
  // Updates
  // ---------------------------------------------------------------------------

  updateNodeMetrics(nodeId: string, partial: Partial<WorkerNodeInfo>): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const updated = { ...node, ...partial };
    this.nodes.set(nodeId, updated);
    this.emit('node:updated', updated);
  }

  updateHeartbeat(nodeId: string, capabilities: WorkerNodeCapabilities): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    const updated: WorkerNodeInfo = {
      ...node,
      capabilities: { ...capabilities },
      lastHeartbeat: Date.now(),
      status: node.status !== 'connected' ? 'connected' : node.status,
    };
    this.nodes.set(nodeId, updated);
    this.emit('node:updated', updated);
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  selectNode(prefs: NodePlacementPrefs): WorkerNodeInfo | null {
    const candidates = this.getHealthyNodes();
    if (candidates.length === 0) return null;

    let bestNode: WorkerNodeInfo | null = null;
    let bestScore = -Infinity;

    for (const node of candidates) {
      const score = this.scoreNode(node, prefs);
      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    }

    // Return null if no candidate reached a positive score
    if (bestScore <= 0) return null;

    logger.info('Node selected', { nodeId: bestNode?.id, score: bestScore });
    return bestNode;
  }

  private scoreNode(node: WorkerNodeInfo, prefs: NodePlacementPrefs): number {
    const caps = node.capabilities;

    // --- Hard filters ---
    if (node.activeInstances >= caps.maxConcurrentInstances) return -Infinity;
    if (prefs.requiresBrowser && !caps.hasBrowserRuntime) return -Infinity;
    if (prefs.requiresGpu && !caps.gpuName) return -Infinity;
    if (prefs.requiresCli && !caps.supportedClis.includes(prefs.requiresCli)) return -Infinity;

    // --- Base capability match ---
    let score = 100;

    // Platform preference (+20)
    if (prefs.preferPlatform && caps.platform === prefs.preferPlatform) {
      score += 20;
    }

    // Available memory ratio (+30)
    if (caps.totalMemoryMB > 0) {
      score += (caps.availableMemoryMB / caps.totalMemoryMB) * 30;
    }

    // Spare capacity ratio (+25)
    if (caps.maxConcurrentInstances > 0) {
      score += (1 - node.activeInstances / caps.maxConcurrentInstances) * 25;
    }

    // Latency bonus (+0..10, or +5 if unknown)
    if (node.latencyMs !== undefined) {
      score += Math.max(0, 10 - node.latencyMs / 10);
    } else {
      score += 5;
    }

    // Preferred node ID boost (+50)
    if (prefs.preferNodeId && node.id === prefs.preferNodeId) {
      score += 50;
    }

    // Required working directory — hard penalty if missing (-200)
    if (prefs.requiresWorkingDirectory) {
      const hasDir = caps.workingDirectories.includes(prefs.requiresWorkingDirectory);
      if (!hasDir) {
        score -= 200;
      }
    }

    return score;
  }
}

export function getWorkerNodeRegistry(): WorkerNodeRegistry {
  return WorkerNodeRegistry.getInstance();
}
