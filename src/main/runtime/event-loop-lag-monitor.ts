/**
 * Event Loop Lag Monitor
 *
 * Tracks main-process event-loop lag using `perf_hooks.monitorEventLoopDelay`
 * when available, with a fallback drift-measurement approach for environments
 * that don't support it.
 *
 * Usage:
 *   const monitor = new EventLoopLagMonitor();
 *   monitor.start();
 *   // ... later ...
 *   const snapshot = monitor.snapshot();
 *   monitor.stop();
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export interface EventLoopLagSnapshot {
  /** Maximum lag observed since last reset, in milliseconds */
  maxMs: number;
  /** p50 lag in milliseconds */
  p50Ms: number;
  /** p95 lag in milliseconds */
  p95Ms: number;
  /** p99 lag in milliseconds */
  p99Ms: number;
  /** Mean lag in milliseconds */
  meanMs: number;
  /** Number of lag samples taken */
  sampleCount: number;
  /** Whether the native histogram API is in use */
  usingNativeHistogram: boolean;
}

export interface EventLoopLagMonitorOptions {
  /** Sampling resolution in ms for native histogram (default: 10) */
  resolutionMs?: number;
  /** Fallback drift-poll interval in ms when native API is unavailable (default: 100) */
  fallbackIntervalMs?: number;
}

const NS_PER_MS = 1_000_000;

export class EventLoopLagMonitor {
  private readonly resolutionMs: number;
  private readonly fallbackIntervalMs: number;

  private histogram: IntervalHistogram | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private fallbackMaxMs = 0;
  private fallbackSamples = 0;
  private fallbackSumMs = 0;
  private fallbackP95Samples: number[] = [];
  private running = false;

  constructor(options: EventLoopLagMonitorOptions = {}) {
    this.resolutionMs = options.resolutionMs ?? 10;
    this.fallbackIntervalMs = options.fallbackIntervalMs ?? 100;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (typeof monitorEventLoopDelay === 'function') {
      this.histogram = monitorEventLoopDelay({ resolution: this.resolutionMs });
      this.histogram.enable();
    } else {
      this.startFallback();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.histogram) {
      this.histogram.disable();
      this.histogram = null;
    }

    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  /** Reset accumulated stats without stopping the monitor. */
  resetStats(): void {
    if (this.histogram) {
      this.histogram.reset();
    }
    this.fallbackMaxMs = 0;
    this.fallbackSamples = 0;
    this.fallbackSumMs = 0;
    this.fallbackP95Samples = [];
  }

  snapshot(): EventLoopLagSnapshot {
    if (this.histogram) {
      const h = this.histogram;
      const sampleCount = h.count;
      return {
        maxMs: h.max / NS_PER_MS,
        p50Ms: h.percentile(50) / NS_PER_MS,
        p95Ms: h.percentile(95) / NS_PER_MS,
        p99Ms: h.percentile(99) / NS_PER_MS,
        meanMs: h.mean / NS_PER_MS,
        sampleCount: sampleCount > 2_147_483_647 ? 2_147_483_647 : Number(sampleCount),
        usingNativeHistogram: true,
      };
    }

    const count = this.fallbackSamples;
    const mean = count > 0 ? this.fallbackSumMs / count : 0;
    const sorted = [...this.fallbackP95Samples].sort((a, b) => a - b);
    const p95idx = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const p99idx = Math.max(0, Math.ceil(sorted.length * 0.99) - 1);

    return {
      maxMs: this.fallbackMaxMs,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95Ms: sorted[p95idx] ?? 0,
      p99Ms: sorted[p99idx] ?? 0,
      meanMs: mean,
      sampleCount: count,
      usingNativeHistogram: false,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  private startFallback(): void {
    const scheduleNext = (): void => {
      const expected = Date.now() + this.fallbackIntervalMs;
      this.fallbackTimer = setTimeout(() => {
        const actual = Date.now();
        const lagMs = Math.max(0, actual - expected);
        this.fallbackMaxMs = Math.max(this.fallbackMaxMs, lagMs);
        this.fallbackSumMs += lagMs;
        this.fallbackSamples++;
        // Keep at most 1000 samples for percentile calculations
        this.fallbackP95Samples.push(lagMs);
        if (this.fallbackP95Samples.length > 1000) {
          this.fallbackP95Samples.shift();
        }
        if (this.running) scheduleNext();
      }, this.fallbackIntervalMs);
      this.fallbackTimer!.unref();
    };
    scheduleNext();
  }
}

let sharedInstance: EventLoopLagMonitor | null = null;

export function getEventLoopLagMonitor(): EventLoopLagMonitor {
  if (!sharedInstance) {
    sharedInstance = new EventLoopLagMonitor();
  }
  return sharedInstance;
}

export function _resetEventLoopLagMonitorForTesting(): void {
  if (sharedInstance?.isRunning) {
    sharedInstance.stop();
  }
  sharedInstance = null;
}
