/**
 * IPC handler timing guardrail.
 *
 * Wraps `ipcMain.handle` once, before any handler is registered, so every IPC
 * handler is timed. We measure the *synchronous prelude* of each handler — the
 * work that runs before the handler's first `await` (i.e. before its promise is
 * returned to the caller). That window is exactly the contribution the handler
 * makes to a main-process event-loop stall: a handler that does synchronous
 * SQLite or heavy CPU shows up here, while one that merely awaits a worker does
 * not.
 *
 * On a prelude longer than the threshold we warn loudly (channel + duration) so
 * the regression is visible in dev and in `app.log`. We deliberately do NOT
 * throw: the handler has already done its work by the time we measure, so
 * throwing would corrupt the response the renderer is waiting on. Visibility is
 * the goal — the watchdog already captures the loop-level stall numbers.
 *
 * This is the hot-path guardrail from the main-thread-offload plan
 * (§Cross-cutting): "warn loudly when any IPC handler blocks the loop beyond
 * ~100ms."
 */

import { performance } from 'node:perf_hooks';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { getLogger } from '../logging/logger';
import { notifySlowOperation } from '../util/slow-operations';

const logger = getLogger('IpcHandlerTiming');

/** Default block-warning threshold, matching slow-operations' 'default'. */
const DEFAULT_BLOCK_WARN_MS = 100;

export interface IpcHandlerTimingOptions {
  /** Warn when a handler's synchronous prelude exceeds this many ms. */
  blockWarnMs?: number;
}

let installed = false;

/**
 * Monkey-patch `ipcMain.handle` so each subsequently-registered handler is
 * wrapped with synchronous-prelude timing. Idempotent: calling twice is a no-op
 * after the first install. Must run before `registerHandlers()`.
 */
export function installIpcHandlerTiming(
  ipcMain: IpcMain,
  options: IpcHandlerTimingOptions = {},
): void {
  if (installed) {
    return;
  }
  installed = true;

  const blockWarnMs = options.blockWarnMs ?? DEFAULT_BLOCK_WARN_MS;
  const originalHandle = ipcMain.handle.bind(ipcMain);

  ipcMain.handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    originalHandle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const start = performance.now();
      try {
        // Invoking an async listener runs its body synchronously up to the first
        // `await`, then returns a promise — so this call measures the prelude.
        return listener(event, ...args);
      } finally {
        const syncMs = performance.now() - start;
        if (syncMs > blockWarnMs) {
          logger.warn('IPC handler blocked the main event loop', {
            channel,
            syncMs: Math.round(syncMs),
            thresholdMs: blockWarnMs,
          });
          notifySlowOperation(`ipc:${channel}`, syncMs, blockWarnMs);
        }
      }
    });
  };
}

/** Test-only: allow re-installing the wrapper in a fresh fake ipcMain. */
export function _resetIpcHandlerTimingForTesting(): void {
  installed = false;
}
