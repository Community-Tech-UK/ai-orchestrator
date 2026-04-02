// src/main/util/slow-operations.ts
/**
 * Slow Operation Detection
 *
 * Wraps async operations with timing guards that fire a configurable callback
 * when a duration threshold is exceeded. Designed for lightweight production
 * use — no build-time elimination needed.
 *
 * Usage:
 *   const result = await measureAsync('session.save', () => saveState());
 *
 *   using op = measureOp('context.compact', 500);
 *   // ... do work ...
 *   // op[Symbol.dispose]() called automatically by 'using' block
 *
 * Telemetry integration:
 *   setSlowOpCallback((name, durationMs, thresholdMs) => {
 *     telemetry.record('slow_op', { name, durationMs, thresholdMs });
 *   });
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('SlowOperations');

// ── Threshold table ───────────────────────────────────────────────────────────

const THRESHOLDS: Record<string, number> = {
  'json.stringify': 50,
  'json.parse': 50,
  'context.compact': 500,
  'session.save': 200,
  'session.restore': 500,
  'embedding.generate': 1000,
  'snapshot.write': 300,
  'default': 100,
};

// ── Global callback ───────────────────────────────────────────────────────────

type SlowOpCallback = (name: string, durationMs: number, thresholdMs: number) => void;

let slowOpCallback: SlowOpCallback | null = null;

/** Set (or clear) the global callback invoked when a slow operation is detected. */
export function setSlowOpCallback(cb: SlowOpCallback | null): void {
  slowOpCallback = cb;
}

// ── Threshold lookup ──────────────────────────────────────────────────────────

/** Returns the threshold in ms for a given operation name. */
export function getThreshold(name: string): number {
  return THRESHOLDS[name] ?? THRESHOLDS['default'];
}

// ── Core detection ────────────────────────────────────────────────────────────

function checkAndNotify(name: string, startMs: number, thresholdMs: number): void {
  const durationMs = Date.now() - startMs;
  if (durationMs > thresholdMs) {
    logger.warn('Slow operation detected', { name, durationMs, thresholdMs });
    slowOpCallback?.(name, durationMs, thresholdMs);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wraps an async function with timing measurement.
 * If the duration exceeds thresholdMs, logs a warning and fires the slow-op callback.
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>,
  thresholdMs?: number,
): Promise<T> {
  const threshold = thresholdMs ?? getThreshold(name);
  const start = Date.now();
  try {
    return await fn();
  } finally {
    checkAndNotify(name, start, threshold);
  }
}

/** Disposable returned by measureOp — used with the 'using' keyword (TS 5.2+). */
export interface Disposable {
  [Symbol.dispose](): void;
}

/**
 * Returns a Disposable that measures elapsed time when disposed.
 * Use with the 'using' keyword for automatic disposal at scope exit.
 */
export function measureOp(name: string, thresholdMs?: number): Disposable {
  const threshold = thresholdMs ?? getThreshold(name);
  const start = Date.now();
  return {
    [Symbol.dispose]() {
      checkAndNotify(name, start, threshold);
    },
  };
}

// ── Instrumented JSON wrappers ────────────────────────────────────────────────

/**
 * JSON.stringify with slow-operation timing.
 */
export function safeStringify(value: unknown): string {
  const threshold = getThreshold('json.stringify');
  const start = Date.now();
  const result = JSON.stringify(value);
  checkAndNotify('json.stringify', start, threshold);
  return result;
}

/**
 * JSON.parse with slow-operation timing.
 * Preserves JSON.parse throw semantics for invalid input.
 */
export function safeParse(json: string): unknown {
  const threshold = getThreshold('json.parse');
  const start = Date.now();
  const result = JSON.parse(json) as unknown;
  checkAndNotify('json.parse', start, threshold);
  return result;
}
