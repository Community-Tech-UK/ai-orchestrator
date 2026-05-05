import type { OperatorNodeType } from '../../shared/types/operator.types';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
import { getOperatorDatabase } from './operator-database';
import { OperatorRunStore } from './operator-run-store';

const logger = getLogger('OperatorStallDetector');

export const DEFAULT_OPERATOR_STALL_CHECK_INTERVAL_MS = 30_000;

export const DEFAULT_OPERATOR_STALL_THRESHOLDS_MS: Record<OperatorNodeType, number> = {
  plan: 5 * 60 * 1000,
  'discover-projects': 5 * 60 * 1000,
  'project-agent': 30 * 60 * 1000,
  'repo-job': 30 * 60 * 1000,
  workflow: 30 * 60 * 1000,
  'git-batch': 5 * 60 * 1000,
  shell: 10 * 60 * 1000,
  verification: 10 * 60 * 1000,
  synthesis: 10 * 60 * 1000,
};

export interface OperatorStallDetectorConfig {
  runStore?: OperatorRunStore;
  thresholds?: Partial<Record<OperatorNodeType, number>>;
  now?: () => number;
}

export interface OperatorStallBlockResult {
  runId: string;
  nodeId: string;
  nodeType: OperatorNodeType;
  lastProgressAt: number;
  stallMs: number;
  thresholdMs: number;
  error: string;
}

export class OperatorStallDetector {
  private static instance: OperatorStallDetector | null = null;
  private readonly runStore: OperatorRunStore;
  private readonly thresholds: Record<OperatorNodeType, number>;
  private readonly now: () => number;
  private interval: NodeJS.Timeout | null = null;
  private unregisterCleanup: (() => void) | null = null;

  static getInstance(config?: OperatorStallDetectorConfig): OperatorStallDetector {
    this.instance ??= new OperatorStallDetector(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  constructor(config: OperatorStallDetectorConfig = {}) {
    this.runStore = config.runStore ?? new OperatorRunStore(getOperatorDatabase().db);
    this.thresholds = {
      ...DEFAULT_OPERATOR_STALL_THRESHOLDS_MS,
      ...(config.thresholds ?? {}),
    };
    this.now = config.now ?? Date.now;
  }

  start(intervalMs = DEFAULT_OPERATOR_STALL_CHECK_INTERVAL_MS): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      try {
        this.checkOnce();
      } catch (error) {
        logger.warn('Operator stall check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, intervalMs);
    if (this.interval.unref) this.interval.unref();
    this.unregisterCleanup = registerCleanup(() => this.stop());
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.unregisterCleanup?.();
    this.unregisterCleanup = null;
  }

  checkOnce(): OperatorStallBlockResult[] {
    const now = this.now();
    const stalledNodes = this.runStore.listStalledNodes({
      now,
      thresholds: this.thresholds,
    });
    const results: OperatorStallBlockResult[] = [];

    for (const stalled of stalledNodes) {
      const error = stallError(stalled.node.type, stalled.thresholdMs);
      this.runStore.appendEvent({
        runId: stalled.run.id,
        nodeId: stalled.node.id,
        kind: 'recovery',
        payload: {
          reason: 'stalled-node',
          action: 'blocked',
          nodeType: stalled.node.type,
          lastProgressAt: stalled.lastProgressAt,
          stallMs: stalled.stallMs,
          thresholdMs: stalled.thresholdMs,
        },
      });
      this.runStore.updateNode(stalled.node.id, {
        status: 'blocked',
        completedAt: now,
        error,
      });

      const currentRun = this.runStore.getRun(stalled.run.id);
      if (currentRun && (currentRun.status === 'running' || currentRun.status === 'waiting')) {
        this.runStore.updateRun(stalled.run.id, {
          status: 'blocked',
          completedAt: now,
          error,
        });
      }

      this.runStore.appendEvent({
        runId: stalled.run.id,
        nodeId: stalled.node.id,
        kind: 'state-change',
        payload: {
          status: 'blocked',
          reason: 'stalled-node',
        },
      });
      logger.warn('Operator node stalled and was blocked', {
        runId: stalled.run.id,
        nodeId: stalled.node.id,
        nodeType: stalled.node.type,
        stallMs: stalled.stallMs,
        thresholdMs: stalled.thresholdMs,
      });
      results.push({
        runId: stalled.run.id,
        nodeId: stalled.node.id,
        nodeType: stalled.node.type,
        lastProgressAt: stalled.lastProgressAt,
        stallMs: stalled.stallMs,
        thresholdMs: stalled.thresholdMs,
        error,
      });
    }

    return results;
  }
}

export function getOperatorStallDetector(config?: OperatorStallDetectorConfig): OperatorStallDetector {
  return OperatorStallDetector.getInstance(config);
}

function stallError(nodeType: OperatorNodeType, thresholdMs: number): string {
  return `Operator node stalled: ${nodeType} exceeded ${thresholdMs}ms without progress`;
}
