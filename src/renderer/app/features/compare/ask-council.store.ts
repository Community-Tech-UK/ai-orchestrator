/**
 * Ask Council Store (WS-B6) — progressive Council run state.
 *
 * `providedIn: 'root'` so the run survives route navigation away from and
 * back to the Ask Council page (only a full renderer reload/app restart
 * loses in-memory state — `initialize()` re-fetches the latest run from the
 * main process's durable CouncilRunStore in that case).
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { CompareIpcService } from '../../core/services/ipc/compare-ipc.service';
import type { CouncilMember, CouncilRun, CouncilSynthesisMethod } from '../../core/services/ipc/compare-ipc.service';

@Injectable({ providedIn: 'root' })
export class AskCouncilStore {
  private readonly ipc = inject(CompareIpcService);

  private readonly _run = signal<CouncilRun | null>(null);
  private readonly _availableProviders = signal<string[]>([]);
  private readonly _loadingProviders = signal(false);
  private readonly _starting = signal(false);
  private readonly _synthesizing = signal(false);
  private readonly _errorMessage = signal<string | null>(null);

  private cleanupFns: (() => void)[] = [];
  private initialized = false;
  /**
   * WS-B6 LT-197: `compareStart()`'s own invoke() response always reflects
   * the run's initial all-`queued` snapshot (captured synchronously before
   * any member starts) — but the main process fires member-status
   * `run-updated` pushes (e.g. `queued` -> `running`) on the very next tick
   * after that, via a *separate* IPC channel with no ordering guarantee
   * against the invoke() round-trip. A push for the new run's id can land
   * (and, per live reproduction, reliably does for anything but an
   * instant-answering provider) before `start()` even knows that id, so the
   * `onCompareRunUpdated` listener below drops it (no `_run()` to match
   * against yet) — and then `start()`'s own response overwrites `_run` with
   * the stale all-queued snapshot, silently reverting a member that was
   * already running back to `queued` for its entire execution. Buffered here
   * (keyed by run id, cleared every `start()`) so `start()` can adopt
   * whichever is fresher once the id is known.
   */
  private pendingRunUpdates = new Map<string, CouncilRun>();

  readonly run = this._run.asReadonly();
  readonly availableProviders = this._availableProviders.asReadonly();
  readonly loadingProviders = this._loadingProviders.asReadonly();
  readonly starting = this._starting.asReadonly();
  readonly synthesizing = this._synthesizing.asReadonly();
  readonly errorMessage = this._errorMessage.asReadonly();

  readonly members = computed<CouncilMember[]>(() => this._run()?.members ?? []);
  readonly isRunning = computed(() =>
    this.members().some((m) => m.status === 'queued' || m.status === 'running'),
  );
  readonly succeededMembers = computed(() => this.members().filter((m) => m.status === 'succeeded'));
  readonly failedMembers = computed(() =>
    this.members().filter((m) => m.status === 'failed' || m.status === 'cancelled'),
  );
  /** Synthesis needs >= 2 completed answers; does not require every member to be done. */
  readonly canSynthesize = computed(() => this.succeededMembers().length >= 2 && !this._synthesizing());
  readonly canCancel = computed(() => this.isRunning() && !(this._run()?.cancelled ?? false));
  readonly synthesis = computed(() => this._run()?.synthesis ?? null);

  /** Seed available providers + rehydrate the latest run, then subscribe to live updates. Call once. */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.loadProviders();
    await this.rehydrateLatestRun();

    const unsub = this.ipc.onCompareRunUpdated((run) => {
      if (this._run()?.id === run.id) {
        this._run.set(run);
      } else if (this._starting()) {
        // LT-197: might be for the run currently being started, whose id
        // this store does not know yet — buffered, reconciled in start().
        this.pendingRunUpdates.set(run.id, run);
      }
    });
    this.cleanupFns.push(unsub);
  }

  async loadProviders(): Promise<void> {
    this._loadingProviders.set(true);
    try {
      const response = await this.ipc.compareListProviders();
      this._availableProviders.set(response.success && Array.isArray(response.data) ? (response.data as string[]) : []);
    } finally {
      this._loadingProviders.set(false);
    }
  }

  async start(prompt: string, providers: string[], workingDirectory?: string): Promise<void> {
    this._errorMessage.set(null);
    this._starting.set(true);
    this.pendingRunUpdates.clear();
    try {
      const response = await this.ipc.compareStart({ prompt, providers, workingDirectory });
      if (!response.success || !response.data) {
        this._errorMessage.set(response.error?.message ?? 'Failed to start Council run.');
        return;
      }
      // LT-197: a live 'run-updated' push for this run may have already
      // raced ahead of this invoke() response and be buffered under its id —
      // it is strictly fresher than the response (which always reflects the
      // initial all-queued snapshot), so prefer it when present.
      this._run.set(this.pendingRunUpdates.get(response.data.id) ?? response.data);
    } finally {
      this.pendingRunUpdates.clear();
      this._starting.set(false);
    }
  }

  async cancel(): Promise<void> {
    const run = this._run();
    if (!run) return;
    const response = await this.ipc.compareCancel(run.id);
    if (response.success && response.data) {
      this._run.set(response.data);
    } else {
      this._errorMessage.set(response.error?.message ?? 'Failed to cancel Council run.');
    }
  }

  async synthesize(method: CouncilSynthesisMethod): Promise<void> {
    const run = this._run();
    if (!run || !this.canSynthesize()) return;
    this._errorMessage.set(null);
    this._synthesizing.set(true);
    try {
      const response = await this.ipc.compareSynthesize({ runId: run.id, method });
      if (!response.success || !response.data) {
        this._errorMessage.set(response.error?.message ?? 'Synthesis failed.');
        return;
      }
      this._run.set(response.data);
      if (response.data.synthesis?.error) {
        this._errorMessage.set(response.data.synthesis.error);
      }
    } finally {
      this._synthesizing.set(false);
    }
  }

  clearRun(): void {
    this._run.set(null);
    this._errorMessage.set(null);
  }

  destroy(): void {
    for (const fn of this.cleanupFns) fn();
    this.cleanupFns = [];
    this.initialized = false;
  }

  private async rehydrateLatestRun(): Promise<void> {
    const response = await this.ipc.compareGetRun();
    if (response.success && response.data) {
      this._run.set(response.data);
    }
  }
}
