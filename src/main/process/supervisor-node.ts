/**
 * Supervisor Node - Individual supervisor node in the supervision tree
 *
 * Manages a group of workers or child supervisors with configurable
 * restart strategies and health monitoring.
 */

import { EventEmitter } from 'events';
import {
  CircuitBreaker,
  CircuitBreakerConfig,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './circuit-breaker';
import { getLogger } from '../logging/logger';

const logger = getLogger('SupervisorNode');
import type {
  SupervisorConfig,
  SupervisorNode as SupervisorNodeType,
  WorkerNode,
  ChildSpec,
  RestartEvent,
  HealthStatus,
  BackoffState,
  createDefaultSupervisorConfig,
  createDefaultBackoffState,
  isWorkerNode,
  isSupervisorNode,
} from '../../shared/types/supervision.types';

export interface SupervisorNodeConfig extends SupervisorConfig {
  /** Maximum children per node (for auto-expansion) */
  maxChildren: number;
  /** Auto-expand when reaching max children */
  autoExpand: boolean;
  /** Circuit breaker configuration */
  circuitBreaker: CircuitBreakerConfig;
}

export const DEFAULT_NODE_CONFIG: SupervisorNodeConfig = {
  strategy: 'one-for-one',
  maxRestarts: 5,
  maxTime: 60000, // 1 minute
  onExhausted: 'escalate',
  backoff: {
    minDelayMs: 100,
    maxDelayMs: 30000,
    factor: 2,
    jitter: true,
    resetAfterMs: 5000,
  },
  healthCheck: {
    intervalMs: 30000,
    timeoutMs: 5000,
    unhealthyThreshold: 3,
  },
  maxChildren: 16,
  autoExpand: true,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
};

export interface ManagedWorker {
  node: WorkerNode;
  circuitBreaker: CircuitBreaker;
  healthCheckTimer?: NodeJS.Timeout;
}

export class SupervisorNodeManager extends EventEmitter {
  private readonly id: string;
  private readonly name: string;
  private config: SupervisorNodeConfig;
  private workers: Map<string, ManagedWorker> = new Map();
  private childSupervisors: Map<string, SupervisorNodeManager> = new Map();
  private restartHistory: RestartEvent[] = [];
  private healthStatus: HealthStatus;
  private parentNode?: SupervisorNodeManager;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(
    id: string,
    name: string,
    config: Partial<SupervisorNodeConfig> = {},
    parent?: SupervisorNodeManager
  ) {
    super();
    this.id = id;
    this.name = name;
    this.config = { ...DEFAULT_NODE_CONFIG, ...config };
    this.parentNode = parent;
    this.healthStatus = {
      isHealthy: true,
      lastCheck: Date.now(),
      consecutiveFailures: 0,
      issues: [],
    };

    this.startHealthMonitoring();
  }

  // ============================================
  // Worker Management
  // ============================================

  /**
   * Add a worker to this supervisor
   */
  addWorker(spec: ChildSpec): WorkerNode {
    // Check if we need to auto-expand
    if (this.config.autoExpand && this.getTotalChildren() >= this.config.maxChildren) {
      // Create a child supervisor to handle overflow
      const childSupervisor = this.createChildSupervisor();
      return childSupervisor.addWorker(spec);
    }

    const workerId = `worker-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

    const worker: WorkerNode = {
      id: workerId,
      name: spec.name,
      instanceId: '',
      type: 'worker',
      spec,
      status: 'stopped',
      startedAt: 0,
      restartCount: 0,
      consecutiveFailures: 0,
      backoffState: this.createBackoffState(),
    };

    const circuitBreaker = new CircuitBreaker(workerId, this.config.circuitBreaker);
    circuitBreaker.on('state-change', (data) => {
      this.emit('circuit-breaker:state-change', { supervisorId: this.id, ...data });
    });

    this.workers.set(workerId, {
      node: worker,
      circuitBreaker,
    });

    this.emit('worker:added', { supervisorId: this.id, worker });
    return worker;
  }

  /**
   * Remove a worker
   */
  removeWorker(workerId: string): boolean {
    const managed = this.workers.get(workerId);
    if (!managed) {
      // Check child supervisors
      for (const child of this.childSupervisors.values()) {
        if (child.removeWorker(workerId)) {
          return true;
        }
      }
      return false;
    }

    if (managed.healthCheckTimer) {
      clearTimeout(managed.healthCheckTimer);
    }
    managed.circuitBreaker.destroy();
    this.workers.delete(workerId);

    this.emit('worker:removed', { supervisorId: this.id, workerId });
    return true;
  }

  /**
   * Start a worker
   */
  async startWorker(workerId: string): Promise<void> {
    const managed = this.workers.get(workerId);
    if (!managed) {
      // Check child supervisors
      for (const child of this.childSupervisors.values()) {
        const childWorker = child.getWorker(workerId);
        if (childWorker) {
          await child.startWorker(workerId);
          return;
        }
      }
      throw new Error(`Worker not found: ${workerId}`);
    }

    const { node: worker, circuitBreaker } = managed;

    // Check circuit breaker
    if (!circuitBreaker.canRestart()) {
      throw new Error(`Circuit breaker open for worker ${workerId}`);
    }

    try {
      worker.status = 'restarting';
      circuitBreaker.recordRestart();

      worker.instanceId = await worker.spec.startFunc();
      worker.status = 'running';
      worker.startedAt = Date.now();
      worker.consecutiveFailures = 0;

      // Reset backoff on successful start
      this.resetBackoff(worker);
      circuitBreaker.recordSuccess();

      this.emit('worker:started', { supervisorId: this.id, worker });
    } catch (error: unknown) {
      const err = error as { message?: string };
      worker.status = 'failed';
      worker.lastError = err.message;
      circuitBreaker.recordFailure();

      this.emit('worker:start-failed', { supervisorId: this.id, worker, error: err.message });
      throw error;
    }
  }

  /**
   * Stop a worker
   */
  async stopWorker(workerId: string): Promise<void> {
    const managed = this.workers.get(workerId);
    if (!managed) {
      // Check child supervisors
      for (const child of this.childSupervisors.values()) {
        const childWorker = child.getWorker(workerId);
        if (childWorker) {
          await child.stopWorker(workerId);
          return;
        }
      }
      throw new Error(`Worker not found: ${workerId}`);
    }

    const { node: worker } = managed;

    if (worker.spec.stopFunc) {
      await worker.spec.stopFunc(worker.instanceId);
    }

    worker.status = 'stopped';
    this.emit('worker:stopped', { supervisorId: this.id, worker });
  }

  /**
   * Get a worker by ID
   */
  getWorker(workerId: string): WorkerNode | undefined {
    const managed = this.workers.get(workerId);
    if (managed) return managed.node;

    // Check child supervisors
    for (const child of this.childSupervisors.values()) {
      const worker = child.getWorker(workerId);
      if (worker) return worker;
    }
    return undefined;
  }

  // ============================================
  // Failure Handling
  // ============================================

  /**
   * Handle a worker failure
   */
  async handleFailure(workerId: string, error: string): Promise<void> {
    const managed = this.workers.get(workerId);
    if (!managed) {
      // Delegate to child supervisors
      for (const child of this.childSupervisors.values()) {
        const worker = child.getWorker(workerId);
        if (worker) {
          await child.handleFailure(workerId, error);
          return;
        }
      }
      return;
    }

    const { node: worker, circuitBreaker } = managed;

    worker.status = 'failed';
    worker.lastError = error;
    worker.consecutiveFailures++;
    circuitBreaker.recordFailure();

    this.emit('worker:failed', { supervisorId: this.id, worker, error });

    // Check restart type
    if (worker.spec.restartType === 'temporary') {
      this.emit('worker:terminated', { supervisorId: this.id, worker, reason: 'temporary' });
      return;
    }

    if (worker.spec.restartType === 'transient' && !this.isAbnormalTermination(error)) {
      this.emit('worker:terminated', { supervisorId: this.id, worker, reason: 'normal' });
      return;
    }

    // Apply supervision strategy
    await this.applyStrategy(worker, error);
  }

  private isAbnormalTermination(error: string): boolean {
    const normalExitPatterns = ['normal exit', 'completed', 'shutdown', 'graceful'];
    return !normalExitPatterns.some(p => error.toLowerCase().includes(p));
  }

  private async applyStrategy(failedWorker: WorkerNode, error: string): Promise<void> {
    // Check restart limit
    const recentRestarts = this.restartHistory.filter(
      r => Date.now() - r.timestamp < this.config.maxTime
    ).length;

    if (recentRestarts >= this.config.maxRestarts) {
      await this.handleExhausted(failedWorker, error);
      return;
    }

    const managed = this.workers.get(failedWorker.id);
    if (!managed) return;

    // Check circuit breaker
    if (!managed.circuitBreaker.canRestart()) {
      this.emit('circuit-breaker:blocked', {
        supervisorId: this.id,
        worker: failedWorker,
        reason: 'Circuit breaker open',
      });
      await this.handleExhausted(failedWorker, error);
      return;
    }

    // Calculate backoff delay
    const delay = this.calculateBackoff(failedWorker);

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
    this.restartHistory.push(restartEvent);

    // Apply strategy
    switch (this.config.strategy) {
      case 'one-for-one':
        await this.restartOne(failedWorker, delay);
        break;

      case 'one-for-all':
        await this.restartAll(failedWorker, delay);
        break;

      case 'rest-for-one':
        await this.restartRest(failedWorker, delay);
        break;

      case 'simple-one':
        logger.warn('Worker failed (simple-one strategy)', { workerName: failedWorker.name, error });
        this.emit('worker:logged-failure', { supervisorId: this.id, worker: failedWorker, error });
        break;
    }
  }

  private async restartOne(worker: WorkerNode, delay: number): Promise<void> {
    worker.status = 'restarting';
    worker.restartCount++;

    this.emit('worker:restarting', { supervisorId: this.id, worker, delay });

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
      await this.startWorker(worker.id);
    } catch (error) {
      // Start failed, will be handled by startWorker
    }
  }

  private async restartAll(failedWorker: WorkerNode, delay: number): Promise<void> {
    this.emit('supervisor:restarting-all', { supervisorId: this.id, trigger: failedWorker });

    // Stop all workers
    const stopPromises = Array.from(this.workers.values())
      .filter(m => m.node.status === 'running')
      .map(async m => {
        try {
          await this.stopWorker(m.node.id);
        } catch {
          // Ignore stop errors
        }
      });
    await Promise.all(stopPromises);

    await new Promise(resolve => setTimeout(resolve, delay));

    // Restart all in order
    const orderedWorkers = Array.from(this.workers.values())
      .sort((a, b) => a.node.spec.order - b.node.spec.order);

    for (const managed of orderedWorkers) {
      try {
        managed.node.restartCount++;
        await this.startWorker(managed.node.id);
      } catch {
        // Continue with other workers
      }
    }
  }

  private async restartRest(failedWorker: WorkerNode, delay: number): Promise<void> {
    const orderedWorkers = Array.from(this.workers.values())
      .sort((a, b) => a.node.spec.order - b.node.spec.order);
    const failedIndex = orderedWorkers.findIndex(m => m.node.id === failedWorker.id);

    if (failedIndex === -1) return;

    this.emit('supervisor:restarting-rest', { supervisorId: this.id, trigger: failedWorker });

    // Stop failed worker and all after it
    for (let i = failedIndex; i < orderedWorkers.length; i++) {
      const managed = orderedWorkers[i];
      if (managed.node.status === 'running') {
        try {
          await this.stopWorker(managed.node.id);
        } catch {
          // Ignore stop errors
        }
      }
    }

    await new Promise(resolve => setTimeout(resolve, delay));

    // Restart in order
    for (let i = failedIndex; i < orderedWorkers.length; i++) {
      try {
        orderedWorkers[i].node.restartCount++;
        await this.startWorker(orderedWorkers[i].node.id);
      } catch {
        // Continue
      }
    }
  }

  private async handleExhausted(worker: WorkerNode, error: string): Promise<void> {
    this.emit('supervision:exhausted', { supervisorId: this.id, worker });

    switch (this.config.onExhausted) {
      case 'escalate':
        if (this.parentNode) {
          this.emit('supervision:escalated', { from: this.id, to: this.parentNode.id });
          // Parent will handle this supervisor's failure
          this.parentNode.emit('child-supervisor:failed', { childId: this.id, error });
        } else {
          this.healthStatus.isHealthy = false;
          this.healthStatus.issues.push(`Worker ${worker.name} exhausted restarts`);
          this.emit('supervisor:failed', { supervisorId: this.id, reason: 'exhausted' });
        }
        break;

      case 'stop':
        // Stop all workers
        for (const managed of this.workers.values()) {
          if (managed.node.status === 'running') {
            try {
              await this.stopWorker(managed.node.id);
            } catch {
              // Ignore
            }
          }
        }
        this.emit('supervisor:stopped', { supervisorId: this.id, reason: 'exhausted' });
        break;

      case 'ignore':
        logger.warn('Exhausted restarts for worker', { supervisorName: this.name, workerName: worker.name });
        break;

      case 'restart':
      default:
        // One more attempt with max delay
        await this.restartOne(worker, this.config.backoff.maxDelayMs);
        break;
    }
  }

  // ============================================
  // Child Supervisor Management
  // ============================================

  private createChildSupervisor(): SupervisorNodeManager {
    const childId = `supervisor-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const childName = `${this.name}-child-${this.childSupervisors.size + 1}`;

    const child = new SupervisorNodeManager(childId, childName, this.config, this);

    // Forward events
    child.on('worker:added', data => this.emit('worker:added', data));
    child.on('worker:started', data => this.emit('worker:started', data));
    child.on('worker:stopped', data => this.emit('worker:stopped', data));
    child.on('worker:failed', data => this.emit('worker:failed', data));
    child.on('worker:restarting', data => this.emit('worker:restarting', data));
    child.on('circuit-breaker:state-change', data => this.emit('circuit-breaker:state-change', data));

    this.childSupervisors.set(childId, child);
    this.emit('child-supervisor:created', { parentId: this.id, child: { id: childId, name: childName } });

    return child;
  }

  // ============================================
  // Health Monitoring
  // ============================================

  private startHealthMonitoring(): void {
    this.healthCheckInterval = setInterval(() => {
      this.runHealthCheck();
    }, this.config.healthCheck.intervalMs);
  }

  private runHealthCheck(): void {
    this.healthStatus.lastCheck = Date.now();
    const issues: string[] = [];

    // Check workers
    for (const managed of this.workers.values()) {
      if (managed.node.status === 'failed') {
        issues.push(`Worker ${managed.node.name} is failed`);
      }
      if (managed.circuitBreaker.getStatus() === 'open') {
        issues.push(`Circuit breaker open for ${managed.node.name}`);
      }
    }

    // Check child supervisors
    for (const child of this.childSupervisors.values()) {
      const childHealth = child.getHealthStatus();
      if (!childHealth.isHealthy) {
        issues.push(`Child supervisor ${child.name} is unhealthy`);
      }
    }

    const wasHealthy = this.healthStatus.isHealthy;
    this.healthStatus.isHealthy = issues.length === 0;
    this.healthStatus.issues = issues;

    if (issues.length > 0) {
      this.healthStatus.consecutiveFailures++;
    } else {
      this.healthStatus.consecutiveFailures = 0;
    }

    if (wasHealthy !== this.healthStatus.isHealthy) {
      this.emit('health:changed', { supervisorId: this.id, status: this.healthStatus });
    }
  }

  // ============================================
  // Backoff Management
  // ============================================

  private createBackoffState(): BackoffState {
    return {
      currentDelayMs: this.config.backoff.minDelayMs,
      attemptsSinceReset: 0,
      lastAttemptAt: 0,
    };
  }

  private calculateBackoff(worker: WorkerNode): number {
    const state = worker.backoffState;
    let delay = this.config.backoff.minDelayMs * Math.pow(this.config.backoff.factor, state.attemptsSinceReset);
    delay = Math.min(delay, this.config.backoff.maxDelayMs);

    if (this.config.backoff.jitter) {
      const jitterFactor = 0.5 + Math.random();
      delay = Math.round(delay * jitterFactor);
    }

    state.currentDelayMs = delay;
    state.attemptsSinceReset++;
    state.lastAttemptAt = Date.now();

    return delay;
  }

  private resetBackoff(worker: WorkerNode): void {
    worker.backoffState = this.createBackoffState();
    worker.backoffState.lastSuccessAt = Date.now();
  }

  // ============================================
  // Queries
  // ============================================

  getId(): string {
    return this.id;
  }

  getName(): string {
    return this.name;
  }

  getHealthStatus(): HealthStatus {
    return { ...this.healthStatus };
  }

  getTotalChildren(): number {
    let count = this.workers.size;
    for (const child of this.childSupervisors.values()) {
      count += child.getTotalChildren();
    }
    return count;
  }

  getAllWorkers(): WorkerNode[] {
    const workers: WorkerNode[] = [];
    for (const managed of this.workers.values()) {
      workers.push(managed.node);
    }
    for (const child of this.childSupervisors.values()) {
      workers.push(...child.getAllWorkers());
    }
    return workers;
  }

  getRestartHistory(): RestartEvent[] {
    return [...this.restartHistory];
  }

  toJSON(): SupervisorNodeType {
    return {
      id: this.id,
      name: this.name,
      config: this.config,
      children: [
        ...Array.from(this.workers.values()).map(m => m.node),
        ...Array.from(this.childSupervisors.values()).map(c => c.toJSON()),
      ],
      status: this.healthStatus.isHealthy ? 'running' : 'degraded',
      restartHistory: this.restartHistory,
      healthStatus: this.healthStatus,
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  async shutdown(): Promise<void> {
    // Stop health monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Stop all workers
    for (const managed of this.workers.values()) {
      if (managed.node.status === 'running') {
        try {
          await this.stopWorker(managed.node.id);
        } catch {
          // Ignore
        }
      }
      managed.circuitBreaker.destroy();
      if (managed.healthCheckTimer) {
        clearTimeout(managed.healthCheckTimer);
      }
    }

    // Shutdown child supervisors
    for (const child of this.childSupervisors.values()) {
      await child.shutdown();
    }

    this.workers.clear();
    this.childSupervisors.clear();
    this.removeAllListeners();
  }
}
