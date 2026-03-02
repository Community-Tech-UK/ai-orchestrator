/**
 * Supervisor - Erlang/OTP-style supervision patterns for agent management
 * Based on validated patterns from Erlang/OTP, LangGraph, OpenAI Agents SDK, Microsoft AutoGen
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  SupervisionTree,
  SupervisorNode,
  WorkerNode,
  ChildSpec,
  SupervisorConfig,
  RestartAction,
  RestartEvent,
  BackoffState,
  CircuitBreakerState,
  HealthStatus,
  createDefaultSupervisorConfig,
  createDefaultBackoffState,
  calculateBackoffDelay,
  shouldResetBackoff,
  isWorkerNode,
  isSupervisorNode,
} from '../../shared/types/supervision.types';

const logger = getLogger('Supervisor');

export class Supervisor extends EventEmitter {
  private static instance: Supervisor;
  private trees: Map<string, SupervisionTree> = new Map();
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();

  static getInstance(): Supervisor {
    if (!this.instance) {
      this.instance = new Supervisor();
    }
    return this.instance;
  }

  private constructor() {
    super();
  }

  // ============ Tree Management ============

  createTree(instanceId: string, rootConfig?: Partial<SupervisorConfig>): SupervisionTree {
    const config = { ...createDefaultSupervisorConfig(), ...rootConfig };

    const tree: SupervisionTree = {
      root: {
        id: `supervisor-${Date.now()}`,
        name: 'root',
        config,
        children: [],
        status: 'running',
        restartHistory: [],
        healthStatus: {
          isHealthy: true,
          lastCheck: Date.now(),
          consecutiveFailures: 0,
          issues: [],
        },
      },
      metadata: {
        createdAt: Date.now(),
        instanceId,
        totalRestarts: 0,
      },
    };

    this.trees.set(instanceId, tree);
    this.startHealthMonitoring(instanceId, tree);

    this.emit('supervisor:tree-created', { tree });
    return tree;
  }

  addWorker(instanceId: string, spec: ChildSpec, parentId?: string): WorkerNode {
    const tree = this.trees.get(instanceId);
    if (!tree) throw new Error(`No supervision tree for instance: ${instanceId}`);

    const defaultConfig = createDefaultSupervisorConfig();
    const worker: WorkerNode = {
      id: `worker-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      name: spec.name,
      instanceId: '', // Will be set when started
      type: 'worker',
      spec,
      status: 'stopped',
      startedAt: 0,
      restartCount: 0,
      consecutiveFailures: 0,
      backoffState: createDefaultBackoffState(defaultConfig.backoff),
    };

    const parent = parentId ? (this.findNode(tree.root, parentId) as SupervisorNode) : tree.root;

    if (!parent || !isSupervisorNode(parent)) {
      throw new Error(`Parent supervisor not found: ${parentId}`);
    }

    parent.children.push(worker);

    // Initialize circuit breaker for this worker
    this.circuitBreakers.set(worker.id, {
      status: 'closed',
      failureCount: 0,
    });

    this.emit('worker:added', { tree, worker, parent });
    return worker;
  }

  addSupervisor(instanceId: string, name: string, config?: Partial<SupervisorConfig>, parentId?: string): SupervisorNode {
    const tree = this.trees.get(instanceId);
    if (!tree) throw new Error(`No supervision tree for instance: ${instanceId}`);

    const fullConfig = { ...createDefaultSupervisorConfig(), ...config };

    const supervisor: SupervisorNode = {
      id: `supervisor-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      name,
      config: fullConfig,
      children: [],
      status: 'running',
      restartHistory: [],
      healthStatus: {
        isHealthy: true,
        lastCheck: Date.now(),
        consecutiveFailures: 0,
        issues: [],
      },
    };

    const parent = parentId ? (this.findNode(tree.root, parentId) as SupervisorNode) : tree.root;

    if (!parent || !isSupervisorNode(parent)) {
      throw new Error(`Parent supervisor not found: ${parentId}`);
    }

    parent.children.push(supervisor);

    this.emit('supervisor:added', { tree, supervisor, parent });
    return supervisor;
  }

  async startWorker(instanceId: string, workerId: string): Promise<void> {
    const tree = this.trees.get(instanceId);
    if (!tree) throw new Error(`No supervision tree: ${instanceId}`);

    const worker = this.findWorker(tree.root, workerId);
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    try {
      worker.status = 'restarting';
      worker.instanceId = await worker.spec.startFunc();
      worker.status = 'running';
      worker.startedAt = Date.now();
      worker.consecutiveFailures = 0;

      // Reset backoff on successful start
      this.resetBackoff(worker);

      // Reset circuit breaker
      const cb = this.circuitBreakers.get(worker.id);
      if (cb) {
        cb.status = 'closed';
        cb.failureCount = 0;
        cb.lastSuccessAt = Date.now();
      }

      this.emit('worker:started', { tree, worker });
    } catch (error: unknown) {
      const err = error as { message?: string };
      worker.status = 'failed';
      worker.lastError = err.message;
      this.emit('worker:start-failed', { tree, worker, error: err.message });
      throw error;
    }
  }

  async stopWorker(instanceId: string, workerId: string): Promise<void> {
    const tree = this.trees.get(instanceId);
    if (!tree) throw new Error(`No supervision tree: ${instanceId}`);

    const worker = this.findWorker(tree.root, workerId);
    if (!worker) throw new Error(`Worker not found: ${workerId}`);

    if (worker.spec.stopFunc) {
      await worker.spec.stopFunc(worker.instanceId);
    }

    worker.status = 'stopped';
    this.emit('worker:stopped', { tree, worker });
  }

  // ============ Failure Handling ============

  async handleFailure(instanceId: string, childInstanceId: string, error: string): Promise<void> {
    const tree = this.trees.get(instanceId);
    if (!tree) return;

    const { worker, parent } = this.findWorkerAndParent(tree.root, childInstanceId);
    if (!worker || !parent) return;

    worker.status = 'failed';
    worker.lastError = error;
    worker.consecutiveFailures++;

    // Update circuit breaker
    const circuitBreaker = this.circuitBreakers.get(worker.id);
    if (circuitBreaker) {
      circuitBreaker.failureCount++;
      circuitBreaker.lastFailureAt = Date.now();

      // Check circuit breaker threshold
      if (circuitBreaker.failureCount >= parent.config.maxRestarts) {
        circuitBreaker.status = 'open';
        circuitBreaker.openedAt = Date.now();
        this.emit('circuit-breaker:opened', { tree, worker });
      }
    }

    this.emit('worker:failed', { tree, worker, parent, error });

    // Check restart type
    if (worker.spec.restartType === 'temporary') {
      // Never restart temporary workers
      this.emit('worker:terminated', { tree, worker, reason: 'temporary' });
      return;
    }

    if (worker.spec.restartType === 'transient' && !this.isAbnormalTermination(error)) {
      // Don't restart transient workers on normal termination
      this.emit('worker:terminated', { tree, worker, reason: 'normal' });
      return;
    }

    // Apply supervision strategy
    await this.applyStrategy(tree, parent, worker, error);
  }

  private isAbnormalTermination(error: string): boolean {
    const normalExitPatterns = ['normal exit', 'completed', 'shutdown', 'graceful'];
    return !normalExitPatterns.some((p) => error.toLowerCase().includes(p));
  }

  private async applyStrategy(
    tree: SupervisionTree,
    supervisor: SupervisorNode,
    failedWorker: WorkerNode,
    error: string
  ): Promise<void> {
    const config = supervisor.config;

    // Check restart limit
    const recentRestarts = supervisor.restartHistory.filter((r) => Date.now() - r.timestamp < config.maxTime).length;

    if (recentRestarts >= config.maxRestarts) {
      await this.handleExhausted(tree, supervisor, failedWorker, error);
      return;
    }

    // Calculate backoff delay
    const delay = this.calculateBackoff(failedWorker, config);

    // Record restart event
    const restartEvent: RestartEvent = {
      timestamp: Date.now(),
      childId: failedWorker.id,
      childName: failedWorker.name,
      reason: error,
      action: 'restart',
      delayMs: delay,
      attemptNumber: failedWorker.restartCount + 1,
    };
    supervisor.restartHistory.push(restartEvent);
    tree.metadata.totalRestarts++;

    // Apply strategy
    switch (config.strategy) {
      case 'one-for-one':
        await this.restartOne(tree, supervisor, failedWorker, delay);
        break;

      case 'one-for-all':
        await this.restartAll(tree, supervisor, failedWorker, delay);
        break;

      case 'rest-for-one':
        await this.restartRest(tree, supervisor, failedWorker, delay);
        break;

      case 'simple-one':
        this.logFailure(tree, supervisor, failedWorker, error);
        break;
    }
  }

  private calculateBackoff(worker: WorkerNode, config: SupervisorConfig): number {
    const backoffConfig = config.backoff;
    const state = worker.backoffState;

    // Check if we should reset backoff (worker was healthy for a while)
    if (shouldResetBackoff(state, backoffConfig)) {
      this.resetBackoff(worker);
    }

    const delay = calculateBackoffDelay(state, backoffConfig);

    // Update state
    state.currentDelayMs = delay;
    state.attemptsSinceReset++;
    state.lastAttemptAt = Date.now();

    return delay;
  }

  private resetBackoff(worker: WorkerNode): void {
    const defaultConfig = createDefaultSupervisorConfig();
    worker.backoffState = createDefaultBackoffState(defaultConfig.backoff);
    worker.backoffState.lastSuccessAt = Date.now();
  }

  private async restartOne(
    tree: SupervisionTree,
    supervisor: SupervisorNode,
    worker: WorkerNode,
    delay: number
  ): Promise<void> {
    worker.status = 'restarting';
    worker.restartCount++;

    this.emit('worker:restarting', { tree, worker, supervisor, delay });

    // Wait for backoff delay
    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      worker.instanceId = await worker.spec.startFunc();
      worker.status = 'running';
      worker.startedAt = Date.now();
      worker.consecutiveFailures = 0;
      this.resetBackoff(worker);

      this.emit('worker:started', { tree, worker });
    } catch (error: unknown) {
      const err = error as { message?: string };
      worker.status = 'failed';
      worker.lastError = err.message;
      this.emit('worker:restart-failed', { tree, worker, error: err.message });
    }
  }

  private async restartAll(
    tree: SupervisionTree,
    supervisor: SupervisorNode,
    failedWorker: WorkerNode,
    delay: number
  ): Promise<void> {
    this.emit('supervisor:restarting-all', { tree, supervisor, trigger: failedWorker });

    // Stop all children
    for (const child of supervisor.children) {
      if (isWorkerNode(child) && child.status === 'running') {
        try {
          if (child.spec.stopFunc) {
            await child.spec.stopFunc(child.instanceId);
          }
          child.status = 'stopped';
        } catch {
          /* intentionally ignored: stop errors during supervision restart/shutdown are non-critical */
        }
      }
    }

    // Wait for backoff delay
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Restart all children in order
    for (const child of supervisor.children.sort((a, b) => {
      if (isWorkerNode(a) && isWorkerNode(b)) {
        return a.spec.order - b.spec.order;
      }
      return 0;
    })) {
      if (isWorkerNode(child)) {
        try {
          child.instanceId = await child.spec.startFunc();
          child.status = 'running';
          child.startedAt = Date.now();
          child.restartCount++;
          this.emit('worker:started', { tree, worker: child });
        } catch (error: unknown) {
          const err = error as { message?: string };
          child.status = 'failed';
          child.lastError = err.message;
        }
      }
    }
  }

  private async restartRest(
    tree: SupervisionTree,
    supervisor: SupervisorNode,
    failedWorker: WorkerNode,
    delay: number
  ): Promise<void> {
    const workers = supervisor.children.filter(isWorkerNode).sort((a, b) => a.spec.order - b.spec.order);
    const failedIndex = workers.findIndex((w) => w.id === failedWorker.id);

    if (failedIndex === -1) return;

    this.emit('supervisor:restarting-rest', { tree, supervisor, trigger: failedWorker });

    // Stop failed worker and all after it
    for (let i = failedIndex; i < workers.length; i++) {
      const worker = workers[i];
      if (worker.status === 'running') {
        try {
          if (worker.spec.stopFunc) {
            await worker.spec.stopFunc(worker.instanceId);
          }
          worker.status = 'stopped';
        } catch {
          /* intentionally ignored: stop errors during supervision restart/shutdown are non-critical */
        }
      }
    }

    // Wait for backoff delay
    await new Promise((resolve) => setTimeout(resolve, delay));

    // Restart failed worker and all after it in order
    for (let i = failedIndex; i < workers.length; i++) {
      const worker = workers[i];
      try {
        worker.instanceId = await worker.spec.startFunc();
        worker.status = 'running';
        worker.startedAt = Date.now();
        worker.restartCount++;
        this.emit('worker:started', { tree, worker });
      } catch (error: unknown) {
        const err = error as { message?: string };
        worker.status = 'failed';
        worker.lastError = err.message;
      }
    }
  }

  private logFailure(tree: SupervisionTree, supervisor: SupervisorNode, worker: WorkerNode, error: string): void {
    // For simple-one strategy, just log and don't restart
    logger.warn('Worker failed (simple-one strategy)', { workerName: worker.name, error });
    this.emit('worker:logged-failure', { tree, supervisor, worker, error });
  }

  private async handleExhausted(
    tree: SupervisionTree,
    supervisor: SupervisorNode,
    worker: WorkerNode,
    error: string
  ): Promise<void> {
    const config = supervisor.config;

    this.emit('supervision:exhausted', { tree, supervisor, worker });

    switch (config.onExhausted) {
      case 'escalate':
        // Find parent supervisor and escalate
        const { parent: parentSupervisor } = this.findSupervisorAndParent(tree.root, supervisor.id);
        if (parentSupervisor) {
          this.emit('supervision:escalated', { tree, from: supervisor, to: parentSupervisor });
          await this.handleFailure(tree.metadata.instanceId, supervisor.id, `Child exhausted restarts: ${error}`);
        } else {
          // No parent to escalate to
          supervisor.status = 'failed';
          this.emit('supervisor:failed', { tree, supervisor, reason: 'exhausted' });
        }
        break;

      case 'stop':
        // Stop all children
        for (const child of supervisor.children) {
          if (isWorkerNode(child) && child.status === 'running') {
            try {
              if (child.spec.stopFunc) {
                await child.spec.stopFunc(child.instanceId);
              }
              child.status = 'stopped';
            } catch {
              /* intentionally ignored: stop errors during supervision restart/shutdown are non-critical */
            }
          }
        }
        supervisor.status = 'stopped';
        this.emit('supervisor:stopped', { tree, supervisor, reason: 'exhausted' });
        break;

      case 'ignore':
        // Just log and continue
        logger.warn('Supervisor exhausted restarts for worker', { supervisorName: supervisor.name, workerName: worker.name });
        break;

      case 'restart':
      default:
        // One more attempt
        await this.restartOne(tree, supervisor, worker, config.backoff.maxDelayMs);
        break;
    }
  }

  // ============ Health Monitoring ============

  private startHealthMonitoring(instanceId: string, tree: SupervisionTree): void {
    const config = tree.root.config;

    const interval = setInterval(async () => {
      await this.runHealthCheck(tree);
    }, config.healthCheck.intervalMs);

    this.healthCheckIntervals.set(instanceId, interval);
  }

  private async runHealthCheck(tree: SupervisionTree): Promise<void> {
    const checkNode = async (node: SupervisorNode | WorkerNode): Promise<void> => {
      if (isWorkerNode(node)) {
        if (node.status === 'running') {
          node.lastHealthCheck = Date.now();
          // In a real implementation, this would ping the worker
        }
      } else {
        node.healthStatus.lastCheck = Date.now();
        const unhealthyChildren = node.children.filter((c) => {
          if (isWorkerNode(c)) {
            return c.status === 'failed';
          }
          return c.status === 'failed' || c.status === 'degraded';
        });

        if (unhealthyChildren.length > 0) {
          node.healthStatus.isHealthy = false;
          node.healthStatus.issues = unhealthyChildren.map((c) => `${c.name} is unhealthy`);
          node.status = 'degraded';
        } else {
          node.healthStatus.isHealthy = true;
          node.healthStatus.issues = [];
          if (node.status === 'degraded') {
            node.status = 'running';
          }
        }

        // Recursively check children
        for (const child of node.children) {
          await checkNode(child);
        }
      }
    };

    await checkNode(tree.root);
  }

  // ============ Node Finding ============

  private findNode(node: SupervisorNode | WorkerNode, id: string): SupervisorNode | WorkerNode | null {
    if (node.id === id) return node;

    if (isSupervisorNode(node)) {
      for (const child of node.children) {
        const found = this.findNode(child, id);
        if (found) return found;
      }
    }

    return null;
  }

  private findWorker(node: SupervisorNode | WorkerNode, workerId: string): WorkerNode | null {
    if (isWorkerNode(node) && node.id === workerId) return node;

    if (isSupervisorNode(node)) {
      for (const child of node.children) {
        const found = this.findWorker(child, workerId);
        if (found) return found;
      }
    }

    return null;
  }

  private findWorkerByInstanceId(node: SupervisorNode | WorkerNode, instanceId: string): WorkerNode | null {
    if (isWorkerNode(node) && node.instanceId === instanceId) return node;

    if (isSupervisorNode(node)) {
      for (const child of node.children) {
        const found = this.findWorkerByInstanceId(child, instanceId);
        if (found) return found;
      }
    }

    return null;
  }

  private findWorkerAndParent(
    node: SupervisorNode,
    childInstanceId: string,
    parent?: SupervisorNode
  ): { worker: WorkerNode | null; parent: SupervisorNode | null } {
    for (const child of node.children) {
      if (isWorkerNode(child) && child.instanceId === childInstanceId) {
        return { worker: child, parent: node };
      }
      if (isSupervisorNode(child)) {
        const result = this.findWorkerAndParent(child, childInstanceId, node);
        if (result.worker) return result;
      }
    }
    return { worker: null, parent: null };
  }

  private findSupervisorAndParent(
    node: SupervisorNode,
    supervisorId: string,
    parent?: SupervisorNode
  ): { supervisor: SupervisorNode | null; parent: SupervisorNode | null } {
    if (node.id === supervisorId) {
      return { supervisor: node, parent: parent || null };
    }

    for (const child of node.children) {
      if (isSupervisorNode(child)) {
        if (child.id === supervisorId) {
          return { supervisor: child, parent: node };
        }
        const result = this.findSupervisorAndParent(child, supervisorId, node);
        if (result.supervisor) return result;
      }
    }

    return { supervisor: null, parent: null };
  }

  // ============ Queries ============

  getTree(instanceId: string): SupervisionTree | undefined {
    return this.trees.get(instanceId);
  }

  getAllTrees(): SupervisionTree[] {
    return Array.from(this.trees.values());
  }

  getCircuitBreakerState(workerId: string): CircuitBreakerState | undefined {
    return this.circuitBreakers.get(workerId);
  }

  getWorkerStatus(instanceId: string, workerId: string): WorkerNode | null {
    const tree = this.trees.get(instanceId);
    if (!tree) return null;
    return this.findWorker(tree.root, workerId);
  }

  // ============ Cleanup ============

  destroyTree(instanceId: string): void {
    const interval = this.healthCheckIntervals.get(instanceId);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(instanceId);
    }

    const tree = this.trees.get(instanceId);
    if (tree) {
      // Clean up circuit breakers for all workers
      const cleanupNode = (node: SupervisorNode | WorkerNode): void => {
        if (isWorkerNode(node)) {
          this.circuitBreakers.delete(node.id);
        } else {
          for (const child of node.children) {
            cleanupNode(child);
          }
        }
      };
      cleanupNode(tree.root);
    }

    this.trees.delete(instanceId);
    this.emit('supervisor:tree-destroyed', { instanceId });
  }

  destroy(): void {
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
    this.trees.clear();
    this.circuitBreakers.clear();
  }
}

// Singleton accessor
let supervisorInstance: Supervisor | null = null;

export function getSupervisor(): Supervisor {
  if (!supervisorInstance) {
    supervisorInstance = Supervisor.getInstance();
  }
  return supervisorInstance;
}
