/**
 * StaleRuntimeReconciler — detects CLI processes that died without emitting
 * an exit event and marks their instances as `error`.
 *
 * Motivated by claude3.md §5: if Claude CLI dies (segfault, OOM, machine
 * sleep) without emitting an exit event, the Instance stays `busy` forever.
 * StuckProcessDetector only fires on elapsed-time timeout, not observed death.
 *
 * This reconciler uses `process.kill(pid, 0)` — a zero-signal probe that
 * succeeds if the process exists and throws ESRCH otherwise — to detect dead
 * runtimes during periodic enrichment, matching the pattern described in
 * agent-orchestrator:packages/core/src/lifecycle-manager.ts.
 */

import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('StaleRuntimeReconciler');

const RECONCILE_INTERVAL_MS = 15_000;

/** Statuses where we expect a live PID to be attached. */
const LIVE_PROCESS_STATUSES = new Set([
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'respawning',
  'waking',
]);

export interface ReconcilerInstanceView {
  id: string;
  status: string;
  processId: number | null;
}

export interface ReconcilerDeps {
  getInstances(): ReconcilerInstanceView[];
  markRuntimeLost(instanceId: string): void;
}

/** Returns true if the OS process is still alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class StaleRuntimeReconciler {
  private static instance: StaleRuntimeReconciler | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private constructor(private readonly deps: ReconcilerDeps) {
    this.intervalHandle = setInterval(
      () => this.reconcile(),
      RECONCILE_INTERVAL_MS,
    );
    if (this.intervalHandle.unref) this.intervalHandle.unref();
    registerCleanup(() => this.shutdown());
  }

  static getInstance(deps: ReconcilerDeps): StaleRuntimeReconciler {
    if (!this.instance) this.instance = new StaleRuntimeReconciler(deps);
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) this.instance.shutdown();
    this.instance = null;
  }

  reconcile(): void {
    const instances = this.deps.getInstances();
    for (const inst of instances) {
      if (!LIVE_PROCESS_STATUSES.has(inst.status)) continue;
      if (inst.processId === null) continue;
      if (!isProcessAlive(inst.processId)) {
        logger.warn('Stale runtime detected — CLI process is gone', {
          instanceId: inst.id,
          pid: inst.processId,
          status: inst.status,
        });
        this.deps.markRuntimeLost(inst.id);
      }
    }
  }

  shutdown(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
