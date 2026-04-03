import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { MemoryPressureLevel } from '../memory/memory-monitor';

const logger = getLogger('LoadBalancer');

export interface LoadMetrics {
  activeTasks: number;
  contextUsagePercent: number;
  memoryPressure: MemoryPressureLevel;
  status: string;
  lastUpdated?: number;
  /** Network latency to remote node (undefined for local instances) */
  nodeLatencyMs?: number;
}

export interface LoadBalancerConfig {
  weightActiveTasks: number;        // Weight for active task count (default: 0.4)
  weightContextUsage: number;       // Weight for context usage % (default: 0.3)
  weightMemoryPressure: number;     // Weight for memory pressure (default: 0.3)
  excludeCriticalMemory: boolean;   // Skip instances at critical (default: true)
  excludeTerminated: boolean;       // Skip terminated instances (default: true)
  staleMetricsMs: number;           // Ignore metrics older than this (default: 60s)
}

const DEFAULT_CONFIG: LoadBalancerConfig = {
  weightActiveTasks: 0.4,
  weightContextUsage: 0.3,
  weightMemoryPressure: 0.3,
  excludeCriticalMemory: true,
  excludeTerminated: true,
  staleMetricsMs: 60 * 1000,
};

const PRESSURE_SCORES: Record<MemoryPressureLevel, number> = {
  normal: 0,
  warning: 50,
  critical: 100,
};

export class LoadBalancer extends EventEmitter {
  private config: LoadBalancerConfig;
  private metrics = new Map<string, LoadMetrics>();

  private static instance: LoadBalancer;

  static getInstance(): LoadBalancer {
    if (!this.instance) {
      this.instance = new LoadBalancer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  constructor(config?: Partial<LoadBalancerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateMetrics(instanceId: string, metrics: LoadMetrics): void {
    this.metrics.set(instanceId, { ...metrics, lastUpdated: Date.now() });
  }

  removeMetrics(instanceId: string): void {
    this.metrics.delete(instanceId);
  }

  getMetrics(instanceId: string): LoadMetrics | undefined {
    return this.metrics.get(instanceId);
  }

  getAllMetrics(): Map<string, LoadMetrics> {
    return new Map(this.metrics);
  }

  configure(updates: Partial<LoadBalancerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Select the least-loaded instance from the given candidates.
   * Returns instanceId or null if none eligible.
   */
  selectLeastLoaded(candidateIds: string[]): string | null {
    const now = Date.now();
    let bestId: string | null = null;
    let bestScore = Infinity;

    for (const id of candidateIds) {
      const m = this.metrics.get(id);
      if (!m) continue;

      // Skip stale metrics
      if (m.lastUpdated && (now - m.lastUpdated) > this.config.staleMetricsMs) continue;

      // Exclude critical memory instances
      if (this.config.excludeCriticalMemory && m.memoryPressure === 'critical') continue;

      // Exclude terminated
      if (this.config.excludeTerminated && m.status === 'terminated') continue;

      const score = this.computeScore(m);
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    if (bestId) {
      logger.info('Selected least-loaded instance', { instanceId: bestId, score: bestScore });
    }

    return bestId;
  }

  /**
   * Select the best N instances for parallel work distribution.
   */
  selectTopN(candidateIds: string[], n: number): string[] {
    const scored = candidateIds
      .map(id => ({ id, metrics: this.metrics.get(id) }))
      .filter(({ metrics }) => {
        if (!metrics) return false;
        if (metrics.lastUpdated && (Date.now() - metrics.lastUpdated) > this.config.staleMetricsMs) return false;
        if (this.config.excludeCriticalMemory && metrics.memoryPressure === 'critical') return false;
        if (this.config.excludeTerminated && metrics.status === 'terminated') return false;
        return true;
      })
      .map(({ id, metrics }) => ({ id, score: this.computeScore(metrics!) }))
      .sort((a, b) => a.score - b.score);

    return scored.slice(0, n).map(s => s.id);
  }

  getStats(): { trackedInstances: number; avgLoad: number } {
    const values = [...this.metrics.values()];
    const avgLoad = values.length === 0 ? 0 :
      values.reduce((sum, m) => sum + this.computeScore(m), 0) / values.length;
    return { trackedInstances: this.metrics.size, avgLoad: Math.round(avgLoad) };
  }

  private computeScore(m: LoadMetrics): number {
    const taskScore = Math.min(m.activeTasks * 25, 100); // Normalize: 4 tasks = 100
    const contextScore = m.contextUsagePercent;
    const pressureScore = PRESSURE_SCORES[m.memoryPressure] ?? 0;
    const latencyPenalty = m.nodeLatencyMs ? Math.min(m.nodeLatencyMs / 10, 20) : 0;

    return (
      this.config.weightActiveTasks * taskScore +
      this.config.weightContextUsage * contextScore +
      this.config.weightMemoryPressure * pressureScore +
      latencyPenalty
    );
  }
}

export function getLoadBalancer(): LoadBalancer {
  return LoadBalancer.getInstance();
}
