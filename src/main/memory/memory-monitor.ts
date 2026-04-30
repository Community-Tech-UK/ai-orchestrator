/**
 * Memory Monitor - Tracks memory usage and triggers actions on memory pressure
 */

import { EventEmitter } from 'events';
import * as os from 'node:os';
import * as v8 from 'node:v8';

export interface MemoryStats {
  heapUsedMB: number;
  heapTotalMB: number;
  externalMB: number;
  rssMB: number;
  percentUsed: number;
}

export type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

export interface MemoryMonitorConfig {
  warningThresholdMB: number;
  criticalThresholdMB: number;
  checkIntervalMs: number;
}

const BYTES_PER_MB = 1024 * 1024;
const MIN_WARNING_THRESHOLD_MB = 1024;
const MIN_CRITICAL_THRESHOLD_MB = 1536;
const SYSTEM_MEMORY_BUDGET_RATIO = 0.25;
const WARNING_BUDGET_RATIO = 0.7;
const CRITICAL_BUDGET_RATIO = 0.85;

const DEFAULT_CONFIG: MemoryMonitorConfig = {
  ...getDefaultMemoryThresholds(),
  checkIntervalMs: 10000, // 10 seconds
};

function toMB(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

function getDefaultMemoryThresholds(): Pick<MemoryMonitorConfig, 'warningThresholdMB' | 'criticalThresholdMB'> {
  const heapLimitMB = toMB(v8.getHeapStatistics().heap_size_limit);
  const systemBudgetMB = toMB(os.totalmem()) * SYSTEM_MEMORY_BUDGET_RATIO;
  const effectiveBudgetMB = Math.max(
    MIN_CRITICAL_THRESHOLD_MB,
    Math.min(heapLimitMB, systemBudgetMB),
  );
  const warningThresholdMB = Math.round(Math.max(
    MIN_WARNING_THRESHOLD_MB,
    effectiveBudgetMB * WARNING_BUDGET_RATIO,
  ));
  const criticalThresholdMB = Math.round(Math.max(
    MIN_CRITICAL_THRESHOLD_MB,
    warningThresholdMB + 256,
    effectiveBudgetMB * CRITICAL_BUDGET_RATIO,
  ));

  return {
    warningThresholdMB,
    criticalThresholdMB,
  };
}

export class MemoryMonitor extends EventEmitter {
  private config: MemoryMonitorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private lastPressureLevel: MemoryPressureLevel = 'normal';
  private lastStats: MemoryStats | null = null;

  constructor(config: Partial<MemoryMonitorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<MemoryMonitorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Start monitoring memory usage
   */
  start(): void {
    if (this.intervalId) return;

    this.checkMemory(); // Initial check
    this.intervalId = setInterval(() => this.checkMemory(), this.config.checkIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Get current memory statistics
   */
  getStats(): MemoryStats {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / (1024 * 1024) * 100) / 100;
    const heapTotalMB = Math.round(usage.heapTotal / (1024 * 1024) * 100) / 100;

    return {
      heapUsedMB,
      heapTotalMB,
      externalMB: Math.round(usage.external / (1024 * 1024) * 100) / 100,
      rssMB: Math.round(usage.rss / (1024 * 1024) * 100) / 100,
      percentUsed: Math.round((heapUsedMB / heapTotalMB) * 100),
    };
  }

  /**
   * Get current pressure level
   */
  getPressureLevel(): MemoryPressureLevel {
    return this.lastPressureLevel;
  }

  /**
   * Get last recorded stats
   */
  getLastStats(): MemoryStats | null {
    return this.lastStats;
  }

  /**
   * Force a garbage collection if exposed (--expose-gc flag)
   */
  requestGC(): boolean {
    if (global.gc) {
      global.gc();
      return true;
    }
    return false;
  }

  /**
   * Check memory and emit events if thresholds exceeded
   */
  private checkMemory(): void {
    const stats = this.getStats();
    this.lastStats = stats;

    const pressureLevel = this.calculatePressureLevel(stats.heapUsedMB);

    // Emit stats update
    this.emit('stats', stats);

    // Check for pressure level changes
    if (pressureLevel !== this.lastPressureLevel) {
      this.lastPressureLevel = pressureLevel;

      if (pressureLevel === 'warning') {
        this.emit('warning', stats);
      } else if (pressureLevel === 'critical') {
        this.emit('critical', stats);
      } else if (pressureLevel === 'normal') {
        this.emit('normal', stats);
      }

      this.emit('pressure-change', pressureLevel, stats);
    }
  }

  /**
   * Calculate pressure level based on heap usage
   */
  private calculatePressureLevel(heapUsedMB: number): MemoryPressureLevel {
    if (this.config.criticalThresholdMB > 0 && heapUsedMB >= this.config.criticalThresholdMB) {
      return 'critical';
    }
    if (this.config.warningThresholdMB > 0 && heapUsedMB >= this.config.warningThresholdMB) {
      return 'warning';
    }
    return 'normal';
  }
}

// Singleton instance
let memoryMonitor: MemoryMonitor | null = null;

export function getMemoryMonitor(): MemoryMonitor {
  if (!memoryMonitor) {
    memoryMonitor = new MemoryMonitor();
  }
  return memoryMonitor;
}

export function _resetMemoryMonitorForTesting(): void {
  memoryMonitor = null;
}
