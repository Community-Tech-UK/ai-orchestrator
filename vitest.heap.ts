import { totalmem } from 'os';

/**
 * Old-space ceiling for the Vitest fork workers.
 *
 * Every project in this repo runs `singleFork`, so ONE Node process executes a
 * project's whole spec list back to back. Retained state (module graphs, fakes,
 * listeners) accumulates across ~1.5k files, and a full run on 2026-08-20 hit
 * V8's default ~4 GB old-space ceiling after 771 files and died mid-suite:
 *
 *   FATAL ERROR: Ineffective mark-compacts near heap limit - JS heap OOM
 *   ... followed by ERR_IPC_CHANNEL_CLOSED in the parent's ProcessWorker.send
 *
 * `--max-old-space-size` is a ceiling, not an allocation: V8 only grows into it
 * under real pressure, so raising it costs nothing on a run that stays small.
 *
 * It is only raised on hosts with room to spare. On a small CI runner a ceiling
 * at or above physical memory trades a clean V8 OOM for an OS OOM-kill, which
 * is strictly worse, so those hosts keep Node's own default.
 */

const MB = 1024 * 1024;
/** Enough headroom for the full suite with ~2x margin; more just delays GC. */
const MAX_BUDGET_MB = 8192;
/** Below this a raise is not worth the OOM-kill risk — keep the Node default. */
const MIN_BUDGET_MB = 6144;
/** Never claim more than this share of host RAM for one worker. */
const HOST_SHARE = 4;

/** Heap ceiling in MB for a test worker, or null to keep Node's default. */
export function testHeapBudgetMb(totalMemBytes: number = totalmem()): number | null {
  const budget = Math.min(MAX_BUDGET_MB, Math.floor(totalMemBytes / MB / HOST_SHARE));
  return budget >= MIN_BUDGET_MB ? budget : null;
}

/** `poolOptions.forks.execArgv` value carrying the heap ceiling (empty when unraised). */
export function testHeapExecArgv(totalMemBytes: number = totalmem()): string[] {
  const budget = testHeapBudgetMb(totalMemBytes);
  return budget === null ? [] : [`--max-old-space-size=${budget}`];
}
