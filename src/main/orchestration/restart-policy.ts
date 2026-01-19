/**
 * Restart Policy
 * Erlang/OTP-inspired restart policies for supervised workers
 */

import { EventEmitter } from 'events';
import type { SupervisionStrategy } from '../../shared/types/supervision.types';

// Local type for restart intensity
export interface RestartIntensity {
  maxRestarts: number;
  maxTime: number;
}

export interface RestartDecision {
  shouldRestart: boolean;
  reason: string;
  delay?: number; // ms to wait before restart
  action: 'restart' | 'escalate' | 'stop' | 'human';
}

export interface FailureRecord {
  workerId: string;
  timestamp: number;
  error: string;
  restartAttempt: number;
}

export interface WorkerState {
  id: string;
  restartCount: number;
  failures: FailureRecord[];
  lastRestartTime?: number;
  status: 'running' | 'stopped' | 'restarting' | 'failed';
}

export interface RestartPolicyConfig {
  maxRestarts: number;
  maxTime: number; // Time window in ms
  baseDelay: number; // Initial restart delay in ms
  maxDelay: number; // Maximum restart delay in ms
  backoffMultiplier: number; // Exponential backoff multiplier
  cooldownPeriod: number; // Period after which restart count resets
}

export class RestartPolicy extends EventEmitter {
  private static instance: RestartPolicy;
  private workers: Map<string, WorkerState> = new Map();
  private config: RestartPolicyConfig;

  private defaultConfig: RestartPolicyConfig = {
    maxRestarts: 3,
    maxTime: 60000, // 1 minute
    baseDelay: 1000, // 1 second
    maxDelay: 30000, // 30 seconds
    backoffMultiplier: 2,
    cooldownPeriod: 300000, // 5 minutes
  };

  static getInstance(): RestartPolicy {
    if (!this.instance) {
      this.instance = new RestartPolicy();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<RestartPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Worker Management ============

  registerWorker(workerId: string): void {
    this.workers.set(workerId, {
      id: workerId,
      restartCount: 0,
      failures: [],
      status: 'running',
    });
  }

  unregisterWorker(workerId: string): void {
    this.workers.delete(workerId);
  }

  getWorkerState(workerId: string): WorkerState | undefined {
    return this.workers.get(workerId);
  }

  // ============ Failure Handling ============

  recordFailure(workerId: string, error: string): FailureRecord {
    let worker = this.workers.get(workerId);

    if (!worker) {
      worker = {
        id: workerId,
        restartCount: 0,
        failures: [],
        status: 'running',
      };
      this.workers.set(workerId, worker);
    }

    const failure: FailureRecord = {
      workerId,
      timestamp: Date.now(),
      error,
      restartAttempt: worker.restartCount + 1,
    };

    worker.failures.push(failure);
    worker.status = 'failed';

    // Clean up old failures outside the time window
    this.cleanupOldFailures(worker);

    this.emit('failure:recorded', failure);

    return failure;
  }

  private cleanupOldFailures(worker: WorkerState): void {
    const cutoff = Date.now() - this.config.maxTime;
    worker.failures = worker.failures.filter(f => f.timestamp > cutoff);
  }

  // ============ Restart Decisions ============

  shouldRestart(
    workerId: string,
    strategy: SupervisionStrategy,
    customIntensity?: RestartIntensity
  ): RestartDecision {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return {
        shouldRestart: false,
        reason: 'Worker not found',
        action: 'stop',
      };
    }

    const intensity = customIntensity || {
      maxRestarts: this.config.maxRestarts,
      maxTime: this.config.maxTime,
    };

    // Clean up old failures first
    this.cleanupOldFailures(worker);

    // Check restart count within time window
    const recentFailures = worker.failures.length;

    if (recentFailures >= intensity.maxRestarts) {
      return this.handleMaxRestartsExceeded(worker, strategy);
    }

    // Check cooldown period (reset count if enough time has passed)
    if (worker.lastRestartTime && Date.now() - worker.lastRestartTime > this.config.cooldownPeriod) {
      worker.restartCount = 0;
    }

    // Calculate restart delay with exponential backoff
    const delay = this.calculateBackoff(worker.restartCount);

    worker.restartCount++;
    worker.lastRestartTime = Date.now();
    worker.status = 'restarting';

    this.emit('restart:scheduled', { workerId, delay, attempt: worker.restartCount });

    return {
      shouldRestart: true,
      reason: `Restart attempt ${worker.restartCount}/${intensity.maxRestarts}`,
      delay,
      action: 'restart',
    };
  }

  private handleMaxRestartsExceeded(
    worker: WorkerState,
    strategy: SupervisionStrategy
  ): RestartDecision {
    worker.status = 'failed';

    switch (strategy) {
      case 'one-for-one':
        // Just stop this worker
        return {
          shouldRestart: false,
          reason: 'Max restarts exceeded, stopping worker',
          action: 'stop',
        };

      case 'one-for-all':
      case 'rest-for-one':
        // Escalate to supervisor
        return {
          shouldRestart: false,
          reason: 'Max restarts exceeded, escalating to supervisor',
          action: 'escalate',
        };

      case 'simple-one':
        // Just report, don't restart
        return {
          shouldRestart: false,
          reason: 'Max restarts exceeded, requiring human intervention',
          action: 'human',
        };

      default:
        return {
          shouldRestart: false,
          reason: 'Unknown strategy, stopping worker',
          action: 'stop',
        };
    }
  }

  private calculateBackoff(restartCount: number): number {
    const delay = this.config.baseDelay * Math.pow(this.config.backoffMultiplier, restartCount);
    return Math.min(delay, this.config.maxDelay);
  }

  // ============ Strategy-Specific Logic ============

  getAffectedWorkers(
    failedWorkerId: string,
    allWorkerIds: string[],
    strategy: SupervisionStrategy,
    startOrder: string[]
  ): string[] {
    switch (strategy) {
      case 'one-for-one':
        // Only the failed worker
        return [failedWorkerId];

      case 'one-for-all':
        // All workers
        return allWorkerIds;

      case 'rest-for-one':
        // Failed worker and all started after it
        const failedIndex = startOrder.indexOf(failedWorkerId);
        if (failedIndex === -1) return [failedWorkerId];
        return startOrder.slice(failedIndex);

      case 'simple-one':
        // No restarts
        return [];

      default:
        return [failedWorkerId];
    }
  }

  // ============ Statistics ============

  getStats(workerId?: string): {
    totalRestarts: number;
    totalFailures: number;
    averageTimeBetweenFailures: number;
    workerStates: WorkerState[];
  } {
    const workers = workerId
      ? [this.workers.get(workerId)].filter(Boolean) as WorkerState[]
      : Array.from(this.workers.values());

    const totalRestarts = workers.reduce((sum, w) => sum + w.restartCount, 0);
    const totalFailures = workers.reduce((sum, w) => sum + w.failures.length, 0);

    // Calculate average time between failures
    let totalTimeBetweenFailures = 0;
    let timeBetweenCount = 0;

    for (const worker of workers) {
      for (let i = 1; i < worker.failures.length; i++) {
        totalTimeBetweenFailures += worker.failures[i].timestamp - worker.failures[i - 1].timestamp;
        timeBetweenCount++;
      }
    }

    const averageTimeBetweenFailures =
      timeBetweenCount > 0 ? totalTimeBetweenFailures / timeBetweenCount : 0;

    return {
      totalRestarts,
      totalFailures,
      averageTimeBetweenFailures,
      workerStates: workers,
    };
  }

  // ============ Reset ============

  resetWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.restartCount = 0;
      worker.failures = [];
      worker.status = 'running';
      worker.lastRestartTime = undefined;
      this.emit('worker:reset', { workerId });
    }
  }

  resetAll(): void {
    for (const workerId of this.workers.keys()) {
      this.resetWorker(workerId);
    }
    this.emit('all:reset');
  }
}

// Export singleton getter
export function getRestartPolicy(): RestartPolicy {
  return RestartPolicy.getInstance();
}
