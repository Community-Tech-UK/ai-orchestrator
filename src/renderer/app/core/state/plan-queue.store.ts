import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  PlanQueueAlert,
  PlanQueueControlPayload,
  PlanQueueItemDto,
  PlanQueueKind,
  PlanQueueRunDto,
} from '@contracts/schemas/plan-queue';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';
import { PlanQueueIpcService, type PlanQueueStateChangedPush } from '../services/ipc/plan-queue-ipc.service';

/**
 * One "real" open check from a livetest verdict — the classification a worker
 * cannot resolve itself and genuinely needs James for. Policy-gated and stale
 * entries are surfaced only as a count (see `policyGatedCount`).
 */
export interface PlanQueueNeedJamesRecord {
  readonly runId: string;
  readonly itemId: string;
  readonly documentPath: string;
  readonly check: string;
  readonly reason: string;
}

/**
 * Signal store for the Plan Queue panel. Loads recent runs (with their items)
 * and reconciler alerts on demand, and keeps them current from the
 * `plan-queue:state-changed` push: a run's full DTO replaces the matching
 * entry in place, or — when the coordinator sends `run: null` (e.g. it was not
 * yet initialized when asked) — the whole list is reloaded.
 */
@Injectable({ providedIn: 'root' })
export class PlanQueueStore {
  private ipc = inject(PlanQueueIpcService);

  private runsSignal = signal<PlanQueueRunDto[]>([]);
  private alertsSignal = signal<PlanQueueAlert[]>([]);
  private loading = signal(false);
  private error = signal<string | null>(null);
  private wired = false;

  readonly allRuns = computed(() => this.runsSignal());
  readonly reconcilerAlerts = computed(() => this.alertsSignal());
  readonly isLoading = computed(() => this.loading());
  readonly lastError = computed(() => this.error());

  /**
   * Items across every run waiting on James: a readiness question (needs-answer)
   * or a worker that stopped for input (working / fixing with a question).
   */
  readonly needsAnswerItems = computed<PlanQueueItemDto[]>(() =>
    this.runsSignal().flatMap((run) =>
      run.items.filter((item) => item.question !== null
        && (item.state === 'needs-answer' || item.state === 'working' || item.state === 'fixing')),
    ),
  );

  /**
   * Parked items that still have work to act on. A discarded item keeps its
   * `parked` state but has no branch left, so it drops out of this list.
   */
  readonly parkedItems = computed<PlanQueueItemDto[]>(() =>
    this.runsSignal().flatMap((run) => run.items.filter((item) => item.state === 'parked' && item.branchName !== null)),
  );

  /**
   * Livetest verdicts only — a livetest can PASS with evidence while checks
   * remain genuinely open (see `PlanQueueVerdictSchema.needJames`). Plan
   * verdicts never leave anything open, so this is scoped to `kind === 'livetests'`.
   */
  readonly needJamesReal = computed<PlanQueueNeedJamesRecord[]>(() => {
    const records: PlanQueueNeedJamesRecord[] = [];
    for (const run of this.runsSignal()) {
      if (run.kind !== 'livetests') continue;
      for (const item of run.items) {
        if (!item.verdict) continue;
        for (const entry of item.verdict.needJames) {
          if (entry.classification !== 'real') continue;
          records.push({
            runId: run.id,
            itemId: item.id,
            documentPath: item.documentPath,
            check: entry.check,
            reason: entry.reason,
          });
        }
      }
    }
    return records;
  });

  /** Count of open checks classified policy-gated (a setting or approval rule, not James himself). */
  readonly policyGatedCount = computed<number>(() => {
    let count = 0;
    for (const run of this.runsSignal()) {
      if (run.kind !== 'livetests') continue;
      for (const item of run.items) {
        if (!item.verdict) continue;
        count += item.verdict.needJames.filter((entry) => entry.classification === 'policy-gated').length;
      }
    }
    return count;
  });

  ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.ipc.onStateChanged((event) => this.applyStateChanged(event));
  }

  async load(limit = 50): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.ipc.list(limit);
      if (res.success && res.data) {
        this.runsSignal.set(res.data.runs);
        this.alertsSignal.set(res.data.alerts);
      } else {
        this.error.set(res.error?.message ?? 'Failed to load plan queue runs');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async refreshAlerts(): Promise<void> {
    const res = await this.ipc.alerts();
    if (res.success && res.data) {
      this.alertsSignal.set(res.data.alerts);
    } else {
      this.error.set(res.error?.message ?? 'Failed to refresh reconciler alerts');
    }
  }

  async startRun(payload: {
    parentInstanceId: string;
    kind: PlanQueueKind;
    workspaceCwd: string;
    glob?: string;
  }): Promise<IpcResponse<{ run: PlanQueueRunDto; excluded: string[] }>> {
    const res = await this.ipc.start(payload);
    if (res.success && res.data?.run) {
      this.upsertRun(res.data.run);
    } else if (!res.success) {
      this.error.set(res.error?.message ?? 'Failed to start plan queue run');
    }
    return res;
  }

  async answer(itemId: string, optionId: string): Promise<void> {
    const res = await this.ipc.answer(itemId, optionId);
    if (!res.success) this.error.set(res.error?.message ?? 'Failed to submit answer');
  }

  async control(payload: PlanQueueControlPayload): Promise<void> {
    const res = await this.ipc.control(payload);
    if (!res.success) this.error.set(res.error?.message ?? 'Failed to send control action');
  }

  /** `git diff --shortstat` of a parked item's branch, fetched on demand. */
  async diffstat(itemId: string): Promise<string> {
    const res = await this.ipc.diffstat(itemId);
    if (res.success && res.data) return res.data.diffstat;
    this.error.set(res.error?.message ?? 'Failed to load diffstat');
    return '';
  }

  private applyStateChanged(event: PlanQueueStateChangedPush): void {
    if (!event.run) {
      void this.load();
      return;
    }
    this.upsertRun(event.run);
  }

  private upsertRun(run: PlanQueueRunDto): void {
    this.runsSignal.update((list) => {
      const idx = list.findIndex((r) => r.id === run.id);
      if (idx >= 0) {
        const next = [...list];
        next[idx] = run;
        return next;
      }
      return [run, ...list];
    });
  }
}
