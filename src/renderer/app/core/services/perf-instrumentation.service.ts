/**
 * Performance Instrumentation Service
 *
 * Measures critical UI performance metrics for the operator workspace:
 * - Thread/instance switch time
 * - Transcript initial paint
 * - Scroll performance during large transcripts
 * - Composer latency during streaming
 *
 * Uses Performance API (performance.mark/measure) for accurate timing.
 * Results are collected in a bounded ring buffer for analysis.
 */

import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { LoggingIpcService } from './ipc/logging-ipc.service';

export interface PerfEntry {
  name: string;
  category: 'switch' | 'paint' | 'scroll' | 'composer' | 'render' | 'custom';
  duration: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface PerfSummary {
  metric: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

const MAX_ENTRIES = 500;
const MARK_PREFIX = 'orch:';
const LOG_EXPORT_DELAY_MS = 5_000;

@Injectable({ providedIn: 'root' })
export class PerfInstrumentationService implements OnDestroy {
  private readonly loggingIpc = inject(LoggingIpcService);
  private entries: PerfEntry[] = [];
  private activeMarks = new Map<string, number>();
  private syncScheduled = false;
  private pendingLogEntries = 0;
  private logExportTimer: ReturnType<typeof setTimeout> | null = null;

  /** Signal exposing the latest collected entries (read-only snapshot). */
  private _entries = signal<PerfEntry[]>([]);
  readonly perfEntries = this._entries.asReadonly();

  /** Whether instrumentation is active (can be toggled at runtime). */
  private _enabled = signal(false);
  readonly enabled = this._enabled.asReadonly();

  // ============================================
  // Lifecycle
  // ============================================

  enable(): void {
    this._enabled.set(true);
  }

  disable(): void {
    this._enabled.set(false);
    this.flushLogExport();
  }

  toggle(): void {
    this._enabled.update((v) => !v);
  }

  // ============================================
  // Mark / Measure API
  // ============================================

  /**
   * Start a named timing mark.
   * Returns a stop function for convenience.
   */
  mark(name: string, category: PerfEntry['category'] = 'custom', metadata?: Record<string, unknown>): () => void {
    if (!this._enabled()) return () => { /* noop */ };

    const key = `${MARK_PREFIX}${name}`;
    const startTime = performance.now();
    this.activeMarks.set(key, startTime);

    try {
      performance.mark(`${key}:start`);
    } catch {
      // Performance API may not be available in all contexts
    }

    return () => this.measure(name, category, metadata);
  }

  /**
   * End a named timing mark and record the measurement.
   */
  measure(name: string, category: PerfEntry['category'] = 'custom', metadata?: Record<string, unknown>): number {
    if (!this._enabled()) return 0;

    const key = `${MARK_PREFIX}${name}`;
    const startTime = this.activeMarks.get(key);
    if (startTime === undefined) return 0;

    const duration = performance.now() - startTime;
    this.activeMarks.delete(key);

    try {
      performance.mark(`${key}:end`);
      performance.measure(key, `${key}:start`, `${key}:end`);
    } catch {
      // Cleanup marks silently
    }

    this.record({ name, category, duration, timestamp: Date.now(), metadata });
    return duration;
  }

  /**
   * Record a pre-measured entry directly.
   */
  record(entry: PerfEntry): void {
    if (!this._enabled()) return;

    this.entries.push(entry);

    // Ring buffer: drop oldest when full
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }

    this.scheduleSnapshotSync();
    this.pendingLogEntries += 1;
    this.scheduleLogExport();
  }

  // ============================================
  // Specific Instrumentation Helpers
  // ============================================

  /**
   * Measure instance/thread switch time.
   * Call `markThreadSwitch()` when selection changes, then `measureThreadSwitch()` after paint.
   */
  markThreadSwitch(fromId: string | null, toId: string): () => void {
    return this.mark('thread-switch', 'switch', { fromId, toId });
  }

  /**
   * Measure transcript initial paint time.
   * Call when a new transcript starts rendering, stop after first meaningful paint.
   */
  markTranscriptPaint(instanceId: string, messageCount: number): () => void {
    return this.mark('transcript-paint', 'paint', { instanceId, messageCount });
  }

  /**
   * Record a single scroll frame measurement.
   */
  recordScrollFrame(instanceId: string, frameDuration: number, messageCount: number): void {
    this.record({
      name: 'scroll-frame',
      category: 'scroll',
      duration: frameDuration,
      timestamp: Date.now(),
      metadata: { instanceId, messageCount },
    });
  }

  /**
   * Measure composer input latency during streaming.
   */
  markComposerLatency(): () => void {
    return this.mark('composer-latency', 'composer');
  }

  /**
   * Measure markdown render time for a single content block.
   */
  recordMarkdownRender(contentLength: number, duration: number): void {
    this.record({
      name: 'markdown-render',
      category: 'render',
      duration,
      timestamp: Date.now(),
      metadata: { contentLength },
    });
  }

  /**
   * Measure display items computation time.
   */
  recordDisplayItemsCompute(messageCount: number, itemCount: number, duration: number): void {
    this.record({
      name: 'display-items-compute',
      category: 'render',
      duration,
      timestamp: Date.now(),
      metadata: { messageCount, itemCount },
    });
  }

  // ============================================
  // Analysis
  // ============================================

  /**
   * Get statistical summary for a specific metric.
   */
  getSummary(metricName: string): PerfSummary | null {
    const matching = this.entries.filter((e) => e.name === metricName);
    if (matching.length === 0) return null;

    const durations = matching.map((e) => e.duration).sort((a, b) => a - b);
    const count = durations.length;

    return {
      metric: metricName,
      count,
      min: durations[0],
      max: durations[count - 1],
      mean: durations.reduce((a, b) => a + b, 0) / count,
      p50: durations[Math.floor(count * 0.5)],
      p95: durations[Math.floor(count * 0.95)],
      p99: durations[Math.floor(count * 0.99)],
    };
  }

  /**
   * Get summaries for all tracked metrics.
   */
  getAllSummaries(): PerfSummary[] {
    const metricNames = new Set(this.entries.map((e) => e.name));
    const summaries: PerfSummary[] = [];
    for (const name of metricNames) {
      const summary = this.getSummary(name);
      if (summary) summaries.push(summary);
    }
    return summaries;
  }

  /**
   * Export all entries as JSON (for pasting into benchmark docs).
   */
  exportJSON(): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      summaries: this.getAllSummaries(),
      entries: this.entries,
    }, null, 2);
  }

  /**
   * Print a formatted summary table to the console.
   */
  printSummary(): void {
    const summaries = this.getAllSummaries();
    if (summaries.length === 0) {
      console.log('[PerfInstrumentation] No measurements recorded.');
      return;
    }

    console.group('[PerfInstrumentation] Performance Summary');
    console.table(
      summaries.map((s) => ({
        Metric: s.metric,
        Count: s.count,
        'P50 (ms)': s.p50.toFixed(1),
        'P95 (ms)': s.p95.toFixed(1),
        'P99 (ms)': s.p99.toFixed(1),
        'Min (ms)': s.min.toFixed(1),
        'Max (ms)': s.max.toFixed(1),
        'Mean (ms)': s.mean.toFixed(1),
      }))
    );
    console.groupEnd();
  }

  /**
   * Clear all collected entries.
   */
  clear(): void {
    this.entries = [];
    this.activeMarks.clear();
    this.syncScheduled = false;
    this.pendingLogEntries = 0;
    if (this.logExportTimer !== null) {
      clearTimeout(this.logExportTimer);
      this.logExportTimer = null;
    }
    this._entries.set([]);
  }

  ngOnDestroy(): void {
    this.flushLogExport();
  }

  /**
   * Check if performance targets are met.
   * Returns a list of metrics that exceed their budgets.
   */
  checkBudgets(): { metric: string; target: number; actual: number; unit: string }[] {
    const budgets: Record<string, number> = {
      'thread-switch': 120,      // under 120ms
      'transcript-paint': 200,   // under 200ms
      'composer-latency': 16,    // effectively instantaneous (one frame)
    };

    const violations: { metric: string; target: number; actual: number; unit: string }[] = [];

    for (const [metric, target] of Object.entries(budgets)) {
      const summary = this.getSummary(metric);
      if (summary && summary.p95 > target) {
        violations.push({
          metric,
          target,
          actual: summary.p95,
          unit: 'ms (p95)',
        });
      }
    }

    return violations;
  }

  private scheduleSnapshotSync(): void {
    if (this.syncScheduled) {
      return;
    }

    this.syncScheduled = true;
    queueMicrotask(() => {
      this.syncScheduled = false;
      this._entries.set([...this.entries]);
    });
  }

  private scheduleLogExport(): void {
    if (this.logExportTimer !== null) return;
    this.logExportTimer = setTimeout(() => {
      this.logExportTimer = null;
      this.flushLogExport();
    }, LOG_EXPORT_DELAY_MS);
  }

  private flushLogExport(): void {
    if (this.logExportTimer !== null) {
      clearTimeout(this.logExportTimer);
      this.logExportTimer = null;
    }
    if (this.pendingLogEntries === 0) return;
    const entryCount = this.pendingLogEntries;
    this.pendingLogEntries = 0;
    void this.loggingIpc.logMessage(
      'debug',
      'Renderer performance metrics',
      'PerfInstrumentation',
      {
        entryCount,
        summaries: this.getAllSummaries(),
        budgetViolations: this.checkBudgets(),
      },
    ).catch(() => undefined);
  }
}
