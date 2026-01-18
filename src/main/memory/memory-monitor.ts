/**
 * Memory Monitor - Tracks memory usage and triggers actions on memory pressure
 */

import { EventEmitter } from 'events';

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

const DEFAULT_CONFIG: MemoryMonitorConfig = {
  warningThresholdMB: 1024, // 1GB
  criticalThresholdMB: 1536, // 1.5GB
  checkIntervalMs: 10000, // 10 seconds
};

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
