import { ErrorHandler, Injectable } from '@angular/core';

/** Window type that may have the Electron preload API. */
interface ElectronWindow {
  electronAPI?: {
    infrastructure?: {
      logMessage?: (
        level: 'debug' | 'info' | 'warn' | 'error',
        message: string,
        context?: string,
        metadata?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  };
}

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

/**
 * Global Angular error handler.
 *
 * Catches component render errors, lifecycle hook throws, and uncaught
 * exceptions inside the Angular zone. Forwards them to the main-process
 * structured logger via `window.electronAPI.infrastructure.logMessage` so
 * crashes are captured in the log file and visible in Doctor diagnostics,
 * even before the user can manually trigger an artifact export.
 */
@Injectable()
export class RendererErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    const serialized = serializeError(error);

    // Always log to console so DevTools shows it.
    console.error('[RendererErrorHandler] Uncaught Angular error:', error);

    // Forward to main-process logger over IPC when the Electron preload is
    // available (no-op in tests/browsers where electronAPI is absent).
    const win = window as unknown as ElectronWindow;
    const logFn = win.electronAPI?.infrastructure?.logMessage;
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
}
