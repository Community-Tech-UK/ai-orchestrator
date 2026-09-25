import { ErrorHandler, Injectable } from '@angular/core';

/**
 * Window type that may have the Electron preload API. Preload domains are
 * spread flat onto `electronAPI` (`src/preload/preload.ts`), so `logMessage`
 * lives at the top level, not under a per-domain namespace.
 */
interface ElectronWindow {
  electronAPI?: {
    logMessage?: (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      context?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

/**
 * An error thrown from a computed or template re-fires on every change
 * detection pass. Forward and persist each distinct error at most once per
 * window so one stuck view cannot flood the main-process log or exhaust
 * sessionStorage; the console still receives every occurrence.
 */
const REPEAT_SUPPRESSION_MS = 60_000;
const MAX_TRACKED_SIGNATURES = 50;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  try {
    return { raw: JSON.stringify(error) };
  } catch {
    return { raw: String(error) };
  }
}

function errorSignature(serialized: Record<string, unknown>): string {
  const stack = typeof serialized['stack'] === 'string' ? serialized['stack'] : '';
  const firstFrame = stack.split('\n').find((line) => line.trim().startsWith('at ')) ?? '';
  return [serialized['name'], serialized['message'], serialized['raw'], firstFrame.trim()]
    .map((part) => String(part ?? ''))
    .join('\u0000');
}

/**
 * Global Angular error handler.
 *
 * Catches component render errors, lifecycle hook throws, and uncaught
 * exceptions reported to Angular. Forwards them to the main-process
 * structured logger via `window.electronAPI.logMessage` so crashes are
 * captured in the log file and visible in Doctor diagnostics, even before
 * the user can manually trigger an artifact export.
 */
@Injectable()
export class RendererErrorHandler implements ErrorHandler {
  private readonly lastReportedAt = new Map<string, number>();

  handleError(error: unknown): void {
    const serialized = serializeError(error);

    // Always log to console so DevTools shows it.
    console.error('[RendererErrorHandler] Uncaught Angular error:', error);

    if (!this.shouldReport(errorSignature(serialized), Date.now())) {
      return;
    }

    // Forward to main-process logger over IPC when the Electron preload is
    // available (no-op in tests/browsers where electronAPI is absent).
    const win = window as unknown as ElectronWindow;
    const logFn = win.electronAPI?.logMessage;
    if (typeof logFn === 'function') {
      void logFn(
        'error',
        serialized['message'] ? String(serialized['message']) : 'Uncaught Angular error',
        'RendererErrorHandler',
        serialized,
      ).catch(() => {
        // IPC failure during crash path — nothing we can do, console.error above
        // already surfaced the original error.
      });
    }

    // Persist to sessionStorage so a subsequent page reload can surface the
    // last crash for diagnostics without requiring a live IPC round-trip.
    try {
      const key = `aio:last-renderer-crash:${Date.now()}`;
      sessionStorage.setItem(key, JSON.stringify(serialized));
    } catch {
      // sessionStorage may be unavailable (private browsing, storage full).
    }
  }

  private shouldReport(signature: string, now: number): boolean {
    const last = this.lastReportedAt.get(signature);
    if (last !== undefined && now - last < REPEAT_SUPPRESSION_MS) {
      return false;
    }
    this.lastReportedAt.delete(signature);
    this.lastReportedAt.set(signature, now);
    if (this.lastReportedAt.size > MAX_TRACKED_SIGNATURES) {
      const oldest = this.lastReportedAt.keys().next().value;
      if (oldest !== undefined) {
        this.lastReportedAt.delete(oldest);
      }
    }
    return true;
  }
}
