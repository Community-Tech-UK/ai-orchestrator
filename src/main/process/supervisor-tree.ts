/**
 * Supervisor Tree - Root supervisor with auto-expansion for scaling to 10,000+ instances
 *
 * Provides a hierarchical supervision tree that:
 * - Auto-expands when nodes reach capacity (8-16 children per node)
 * - Integrates with InstanceManager for instance lifecycle events
 * - Supports configurable restart strategies per subtree
 */

import { EventEmitter } from 'events';
import { SupervisorNodeManager, SupervisorNodeConfig, DEFAULT_NODE_CONFIG } from './supervisor-node';
import { getCircuitBreakerRegistry } from './circuit-breaker';
import { getLogger } from '../logging/logger';

const logger = getLogger('SupervisorTree');
import type {
  SupervisionTree,
  SupervisorNode,
  WorkerNode,
  ChildSpec,
  TerminationPolicy,
  ContextInheritanceConfig,
  HierarchyTreeNode,
  HealthStatus,
  createDefaultContextInheritance,
} from '../../shared/types/supervision.types';

export interface SupervisorTreeConfig {
  /** Maximum children per node before auto-expansion */
  maxChildrenPerNode: number;
  /** Enable auto-expansion of tree */
  autoExpand: boolean;
  /** Default node configuration */
  nodeConfig: Partial<SupervisorNodeConfig>;
  /** Health check interval */
  healthCheckIntervalMs: number;
}

export const DEFAULT_TREE_CONFIG: SupervisorTreeConfig = {
  maxChildrenPerNode: 16,
  autoExpand: true,
  nodeConfig: DEFAULT_NODE_CONFIG,
  healthCheckIntervalMs: 30000,
};

export interface InstanceRegistration {
  instanceId: string;
  parentId: string | null;
  workingDirectory: string;
  displayName: string;
  terminationPolicy: TerminationPolicy;
  contextInheritance: ContextInheritanceConfig;
  workerNodeId?: string;
  supervisorNodeId: string;
}

export class SupervisorTree extends EventEmitter {
  private static instance: SupervisorTree;
  private rootSupervisor: SupervisorNodeManager | null = null;
  private config: SupervisorTreeConfig;
  private instances: Map<string, InstanceRegistration> = new Map();
  private workerToInstance: Map<string, string> = new Map();
  private instanceToWorker: Map<string, string> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;

  static getInstance(): SupervisorTree {
    if (!this.instance) {
      this.instance = new SupervisorTree();
    }
    return this.instance;
  }

  /**
   * Reset the singleton instance for testing.
   * This cleans up all state and allows a fresh instance to be created.
   */
  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.destroy();
      (this.instance as any) = undefined;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_TREE_CONFIG };
  }

  /**
   * Configure the supervisor tree
   */
  configure(config: Partial<SupervisorTreeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Initialize the supervisor tree
   */
  initialize(): void {
    if (this.rootSupervisor) return;

    this.rootSupervisor = new SupervisorNodeManager(
      'root-supervisor',
      'Root Supervisor',
      {
        ...DEFAULT_NODE_CONFIG,
        ...this.config.nodeConfig,
        maxChildren: this.config.maxChildrenPerNode,
        autoExpand: this.config.autoExpand,
      }
    );

    this.setupEventForwarding();
    this.startHealthMonitoring();

    logger.info('Initialized root supervisor');
    this.emit('tree:initialized');
  }

  private setupEventForwarding(): void {
    if (!this.rootSupervisor) return;

    this.rootSupervisor.on('worker:added', (data) => {
      this.emit('worker:added', data);
    });

    this.rootSupervisor.on('worker:started', (data) => {
      const instanceId = this.workerToInstance.get(data.worker.id);
      this.emit('worker:started', { ...data, instanceId });
    });

    this.rootSupervisor.on('worker:stopped', (data) => {
      const instanceId = this.workerToInstance.get(data.worker.id);
      this.emit('worker:stopped', { ...data, instanceId });
    });

    this.rootSupervisor.on('worker:failed', (data) => {
      const instanceId = this.workerToInstance.get(data.worker.id);
      this.emit('worker:failed', { ...data, instanceId });
    });

    this.rootSupervisor.on('worker:restarting', (data) => {
      const instanceId = this.workerToInstance.get(data.worker.id);
      this.emit('worker:restarting', { ...data, instanceId });
    });

    this.rootSupervisor.on('circuit-breaker:state-change', (data) => {
      this.emit('circuit-breaker:state-change', data);
    });

    this.rootSupervisor.on('supervision:exhausted', (data) => {
      const instanceId = this.workerToInstance.get(data.worker.id);
      this.emit('supervision:exhausted', { ...data, instanceId });
    });

    this.rootSupervisor.on('supervision:escalated', (data) => {
      this.emit('supervision:escalated', data);
    });

    this.rootSupervisor.on('health:changed', (data) => {
      this.emit('health:changed', data);
    });

    this.rootSupervisor.on('child-supervisor:created', (data) => {
      this.emit('child-supervisor:created', data);
    });
  }

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.runGlobalHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }

  private runGlobalHealthCheck(): void {
    if (!this.rootSupervisor) return;

    const health = this.rootSupervisor.getHealthStatus();
    const totalWorkers = this.rootSupervisor.getTotalChildren();

    this.emit('health:global', {
      timestamp: Date.now(),
      totalWorkers,
      totalInstances: this.instances.size,
      rootHealth: health,
    });
  }

  // ============================================
  // Instance Registration
  // ============================================

  /**
   * Register an instance with the supervision tree
   */
  registerInstance(
    instanceId: string,
    parentId: string | null,
    workingDirectory: string,
    displayName: string,
    terminationPolicy: TerminationPolicy = 'terminate-children',
    contextInheritance?: ContextInheritanceConfig,
    startFunc?: () => Promise<string>,
    stopFunc?: (id: string) => Promise<void>
  ): { supervisorNodeId: string; workerNodeId?: string } {
    if (!this.rootSupervisor) {
      this.initialize();
    }

    // Default context inheritance
    const inheritance: ContextInheritanceConfig = contextInheritance || {
      inheritWorkingDirectory: true,
      inheritEnvironment: true,
      inheritYoloMode: false,
      inheritAgentSettings: false,
    };

    // Calculate depth
    let depth = 0;
    if (parentId) {
      const parentReg = this.instances.get(parentId);
      if (parentReg) {
        const parentWorker = this.rootSupervisor!.getWorker(parentReg.workerNodeId || '');
        depth = parentWorker ? parentWorker.spec.order + 1 : 0;
      }
    }

    const registration: InstanceRegistration = {
      instanceId,
      parentId,
      workingDirectory,
      displayName,
      terminationPolicy,
      contextInheritance: inheritance,
      supervisorNodeId: this.rootSupervisor!.getId(),
    };

    // If start/stop functions provided, register as a worker
    if (startFunc) {
      const spec: ChildSpec = {
        id: instanceId,
        name: displayName,
        restartType: 'transient',
        startFunc,
        stopFunc,
        order: depth,
      };

      const worker = this.rootSupervisor!.addWorker(spec);
      registration.workerNodeId = worker.id;
      registration.supervisorNodeId = this.rootSupervisor!.getId();

      this.workerToInstance.set(worker.id, instanceId);
      this.instanceToWorker.set(instanceId, worker.id);
    }

    this.instances.set(instanceId, registration);

    logger.info('Registered instance', { instanceId, parent: parentId || 'root' });
    this.emit('instance:registered', registration);

    return {
      supervisorNodeId: registration.supervisorNodeId,
      workerNodeId: registration.workerNodeId,
    };
  }

  /**
   * Unregister an instance from the supervision tree
   */
  unregisterInstance(instanceId: string): void {
    const registration = this.instances.get(instanceId);
    if (!registration) return;

    // Handle children based on termination policy
    const children = this.getChildInstances(instanceId);

    switch (registration.terminationPolicy) {
      case 'terminate-children':
        // Children will be terminated by the caller
        break;

      case 'orphan-children':
        // Move children to have no parent (they become root-level)
        for (const childId of children) {
          const childReg = this.instances.get(childId);
          if (childReg) {
            childReg.parentId = null;
          }
        }
        break;

      case 'reparent-to-root':
        // Move children to root supervisor
        for (const childId of children) {
          const childReg = this.instances.get(childId);
          if (childReg) {
            childReg.parentId = null;
            childReg.supervisorNodeId = this.rootSupervisor!.getId();
          }
        }
        break;
    }

    // Remove worker if registered
    if (registration.workerNodeId) {
      this.rootSupervisor?.removeWorker(registration.workerNodeId);
      this.workerToInstance.delete(registration.workerNodeId);
      this.instanceToWorker.delete(instanceId);
    }

    this.instances.delete(instanceId);
    logger.info('Unregistered instance', { instanceId });
    this.emit('instance:unregistered', { instanceId, terminationPolicy: registration.terminationPolicy });
  }

  /**
   * Get child instance IDs for a parent
   */
  getChildInstances(parentId: string): string[] {
    const children: string[] = [];
    for (const [id, reg] of this.instances) {
      if (reg.parentId === parentId) {
        children.push(id);
      }
    }
    return children;
  }

  /**
   * Get all descendant instance IDs (recursive)
   */
  getAllDescendants(instanceId: string): string[] {
    const descendants: string[] = [];
    const children = this.getChildInstances(instanceId);

    for (const childId of children) {
      descendants.push(childId);
      descendants.push(...this.getAllDescendants(childId));
    }

    return descendants;
  }

  // ============================================
  // Failure Handling
  // ============================================

  /**
   * Handle an instance failure
   */
  async handleInstanceFailure(instanceId: string, error: string): Promise<void> {
    const registration = this.instances.get(instanceId);
    if (!registration || !registration.workerNodeId) return;

    await this.rootSupervisor?.handleFailure(registration.workerNodeId, error);
  }

  /**
   * Notify successful instance operation
   */
  notifyInstanceSuccess(instanceId: string): void {
    const workerId = this.instanceToWorker.get(instanceId);
    if (!workerId) return;

    const circuitBreakerRegistry = getCircuitBreakerRegistry();
    const breaker = circuitBreakerRegistry.get(workerId);
    if (breaker) {
      breaker.recordSuccess();
    }
  }

  // ============================================
  // Hierarchy Queries
  // ============================================

  /**
   * Get the hierarchy tree for UI rendering
   */
  getHierarchyTree(): HierarchyTreeNode[] {
    const rootNodes: HierarchyTreeNode[] = [];

    // Find root instances (no parent)
    for (const [instanceId, reg] of this.instances) {
      if (!reg.parentId) {
        const node = this.buildHierarchyNode(instanceId, reg, 0);
        if (node) {
          rootNodes.push(node);
        }
      }
    }

    return rootNodes;
  }

  private buildHierarchyNode(
    instanceId: string,
    registration: InstanceRegistration,
    depth: number
  ): HierarchyTreeNode | null {
    const children: HierarchyTreeNode[] = [];

    // Build child nodes
    for (const [childId, childReg] of this.instances) {
      if (childReg.parentId === instanceId) {
        const childNode = this.buildHierarchyNode(childId, childReg, depth + 1);
        if (childNode) {
          children.push(childNode);
        }
      }
    }

    // Get worker status if registered
    let status = 'unknown';
    let contextUsage = { used: 0, total: 200000, percentage: 0 };

    if (registration.workerNodeId) {
      const worker = this.rootSupervisor?.getWorker(registration.workerNodeId);
      if (worker) {
        status = worker.status;
      }
    }

    return {
      id: instanceId,
      name: registration.displayName,
      status,
      depth,
      parentId: registration.parentId,
      children,
      contextUsage,
      metadata: {
        createdAt: Date.now(), // Would come from instance
        lastActivity: Date.now(),
        agentId: 'unknown',
        terminationPolicy: registration.terminationPolicy,
      },
    };
  }

  /**
   * Get instance registration
   */
  getInstanceRegistration(instanceId: string): InstanceRegistration | undefined {
    return this.instances.get(instanceId);
  }

  /**
   * Get all registrations
   */
  getAllRegistrations(): Map<string, InstanceRegistration> {
    return new Map(this.instances);
  }

  /**
   * Get tree statistics
   */
  getTreeStats(): {
    totalInstances: number;
    totalWorkers: number;
    rootInstances: number;
    maxDepth: number;
    healthStatus: HealthStatus | undefined;
  } {
    let rootInstances = 0;
    let maxDepth = 0;

    for (const reg of this.instances.values()) {
      if (!reg.parentId) rootInstances++;

      // Calculate depth
      let depth = 0;
      let current = reg;
      while (current.parentId) {
        depth++;
        const parent = this.instances.get(current.parentId);
        if (!parent) break;
        current = parent;
      }
      maxDepth = Math.max(maxDepth, depth);
    }

    return {
      totalInstances: this.instances.size,
      totalWorkers: this.rootSupervisor?.getTotalChildren() || 0,
      rootInstances,
      maxDepth,
      healthStatus: this.rootSupervisor?.getHealthStatus(),
    };
  }

  // ============================================
  // Serialization
  // ============================================

  /**
   * Export tree state for IPC
   */
  toJSON(): {
    rootSupervisor: SupervisorNode | null;
    instances: InstanceRegistration[];
    stats: {
      totalInstances: number;
      totalWorkers: number;
      rootInstances: number;
      maxDepth: number;
      healthStatus: HealthStatus | undefined;
    };
  } {
    return {
      rootSupervisor: this.rootSupervisor?.toJSON() || null,
      instances: Array.from(this.instances.values()),
      stats: this.getTreeStats(),
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up event listeners forwarded from rootSupervisor
   */
  private cleanupEventForwarding(): void {
    if (!this.rootSupervisor) return;

    this.rootSupervisor.removeAllListeners('worker:added');
    this.rootSupervisor.removeAllListeners('worker:started');
    this.rootSupervisor.removeAllListeners('worker:stopped');
    this.rootSupervisor.removeAllListeners('worker:failed');
    this.rootSupervisor.removeAllListeners('worker:restarting');
    this.rootSupervisor.removeAllListeners('circuit-breaker:state-change');
    this.rootSupervisor.removeAllListeners('supervision:exhausted');
    this.rootSupervisor.removeAllListeners('supervision:escalated');
    this.rootSupervisor.removeAllListeners('health:changed');
    this.rootSupervisor.removeAllListeners('child-supervisor:created');
  }

  /**
   * Shutdown the supervisor tree
   */
  async shutdown(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Clean up forwarded listeners BEFORE shutting down (while rootSupervisor still exists)
    this.cleanupEventForwarding();

    if (this.rootSupervisor) {
      await this.rootSupervisor.shutdown();
      this.rootSupervisor = null;
    }

    this.instances.clear();
    this.workerToInstance.clear();
    this.instanceToWorker.clear();

    logger.info('Shutdown complete');
    this.emit('tree:shutdown');
  }

  /**
   * Reset the tree (for testing)
   */
  reset(): void {
    this.shutdown();
    this.config = { ...DEFAULT_TREE_CONFIG };
  }

  /**
   * Destroy the tree and clean up all resources
   */
  destroy(): void {
    this.shutdown();
    this.removeAllListeners();
  }
}

// Export singleton getter
export function getSupervisorTree(): SupervisorTree {
  return SupervisorTree.getInstance();
}
