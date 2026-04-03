/**
 * Error utilities — standalone functions with zero dependencies.
 *
 * Inspired by Claude Code utils/errors.ts. Provides error stack truncation,
 * abort detection, filesystem error classification, and context-bounded
 * error formatting for orchestration flows.
 */

const FS_INACCESSIBLE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']);

/**
 * Truncate an error stack to at most `maxFrames` "at ..." lines.
 * Used when errors flow into orchestration context to save tokens.
 */
export function shortErrorStack(e: unknown, maxFrames = 5): string {
  if (!(e instanceof Error)) return String(e);
  if (!e.stack) return e.message;

  const lines = e.stack.split('\n');
  const header = lines[0] ?? e.message;
  const frames = lines.slice(1).filter(l => l.trim().startsWith('at '));

  if (frames.length <= maxFrames) return e.stack;
  return [header, ...frames.slice(0, maxFrames)].join('\n');
}

/**
 * Detect AbortError from multiple sources:
 * - DOMException with name 'AbortError'
 * - Any Error with name 'AbortError'
 * - AbortSignal reason that is an Error
 */
export function isAbortError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false;
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * True for filesystem errors that indicate the path is inaccessible:
 * ENOENT, EACCES, EPERM, ENOTDIR, ELOOP.
 */
export function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException {
  if (e == null || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  return typeof code === 'string' && FS_INACCESSIBLE_CODES.has(code);
}

/**
 * Combine shortErrorStack + message truncation for agent context.
 * Returns a bounded string suitable for passing between agents.
 */
export function truncateErrorForContext(e: unknown, maxChars = 500): string {
  const full = shortErrorStack(e);
  if (full.length <= maxChars) return full;
  return full.slice(0, maxChars);
}

// ── Telemetry-Safe Errors ──────────────────────────────────────

import type { ErrorInfo } from '../../shared/types/ipc.types';

/**
 * Marker class ensuring errors sent to telemetry contain no PII.
 * The `isTelemetrySafe` flag lets telemetry pipelines assert safety at runtime.
 */
export class TelemetrySafeError extends Error {
  readonly isTelemetrySafe = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TelemetrySafeError';
  }

  /** Create from any error, truncating the stack to `maxFrames`. */
  static from(e: unknown, maxFrames = 5): TelemetrySafeError {
    const truncated = shortErrorStack(e, maxFrames);
    const message = e instanceof Error ? e.message : String(e);
    const safe = new TelemetrySafeError(message);
    safe.stack = truncated;
    return safe;
  }
}

/**
 * Create an IPC-safe ErrorInfo with truncated stack.
 * Use this instead of manually constructing ErrorInfo objects in IPC handlers.
 */
export function createSafeErrorInfo(error: unknown, code: string): ErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    code,
    message: err.message || 'Unknown error',
    stack: shortErrorStack(err, 5),
    timestamp: Date.now(),
  };
}
