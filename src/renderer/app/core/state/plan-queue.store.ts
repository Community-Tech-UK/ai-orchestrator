import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  PlanQueueAlert,
  PlanQueueHealth,
  PlanQueueControlPayload,
  PlanQueueItemDto,
  PlanQueueKind,
  PlanQueueRunDto,
} from '@contracts/schemas/plan-queue';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';
import { PlanQueueIpcService, type PlanQueueStateChangedPush } from '../services/ipc/plan-queue-ipc.service';
import { planQueueIsDiscarded } from '../../../../shared/utils/plan-queue-discarded';

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

/** One run's open questions, for the panel's "Needs your answer" section. */
export interface PlanQueueQuestionGroup {
  readonly runId: string;
  readonly kind: PlanQueueKind;
  readonly workspaceCwd: string;
  readonly items: readonly PlanQueueItemDto[];
}

/**
 * Waiting on James: a readiness question (needs-answer) or a worker that
 * stopped for input (working / fixing with a question).
 */
function hasOpenQuestion(item: PlanQueueItemDto): boolean {
  return item.question !== null
    && (item.state === 'needs-answer' || item.state === 'working' || item.state === 'fixing');
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
  private healthSignal = signal<PlanQueueHealth | null>(null);
  private loading = signal(false);
  private error = signal<string | null>(null);
  private retryProgressSignal = signal<{ done: number; total: number; stopping: boolean } | null>(null);
  private retryStopped = false;
  private landingWait: { itemId: string; updatedAt: number | undefined; resolve: () => void } | null = null;
  private wired = false;
  private loadRequested = false;

  readonly allRuns = computed(() => this.runsSignal());
  readonly reconcilerAlerts = computed(() => this.alertsSignal());
  /** Recent landing measures, refreshed with each load of the list. */
  readonly queueHealth = computed(() => this.healthSignal());
  readonly isLoading = computed(() => this.loading());
  readonly lastError = computed(() => this.error());
  /** Where a "try merging all again" has got to, or null when none is running. */
  readonly retryProgress = computed(() => this.retryProgressSignal());

  /** Runs with at least one open question, each with just those items, in run order. */
  readonly questionGroups = computed<PlanQueueQuestionGroup[]>(() =>
    this.runsSignal()
      .map((run) => ({
        runId: run.id,
        kind: run.kind,
        workspaceCwd: run.workspaceCwd,
        items: run.items.filter(hasOpenQuestion),
      }))
      .filter((group) => group.items.length > 0),
  );

  /** Items across every run waiting on James (see `hasOpenQuestion`). */
  readonly needsAnswerItems = computed<PlanQueueItemDto[]>(() =>
    this.questionGroups().flatMap((group) => group.items),
  );

  /**
   * Keep branchless readiness failures visible too. Only an explicit discard
   * receipt removes a set-aside job from the action list.
   */
  readonly parkedItems = computed<PlanQueueItemDto[]>(() =>
    this.runsSignal().flatMap((run) => run.items.filter((item) => item.state === 'parked' && !planQueueIsDiscarded(item))),
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

  /**
   * Load once, for views that only need the list kept current (the session list, the questions banner); the
   * state-changed push keeps it live afterwards. Skipped once any load has been asked for, unless that load failed.
   */
  ensureLoaded(): void {
    this.ensureWired();
    if (!this.loadRequested) void this.load();
  }

  async load(limit = 50): Promise<void> {
    this.loadRequested = true;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.ipc.list(limit);
      if (res.success && res.data) {
        this.runsSignal.set(res.data.runs);
        this.settleLandingWait();
        this.alertsSignal.set(res.data.alerts);
        this.healthSignal.set(res.data.health);
      } else {
        // A failed first load must not stop the next `ensureLoaded` from trying again.
        this.loadRequested = false;
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

  /** The session sorting out this folder's set-aside jobs; null when it could not start. */
  async startSetAsideAgent(workspaceCwd: string): Promise<string | null> {
    const res = await this.ipc.startSetAsideAgent(workspaceCwd);
    if (res.success && res.data) return res.data.instanceId;
    this.error.set(res.error?.message ?? 'Failed to start the set-aside agent');
    return null;
  }

  async answer(itemId: string, optionId: string): Promise<void> {
    const res = await this.ipc.answer(itemId, optionId);
    if (!res.success) this.error.set(res.error?.message ?? 'Failed to submit answer');
  }

  async control(payload: PlanQueueControlPayload): Promise<IpcResponse<null>> {
    const res = await this.ipc.control(payload);
    if (!res.success) this.error.set(res.error?.message ?? 'Failed to send control action');
    else this.error.set(null);
    return res;
  }

  /** One at a time, then one report: a later success must not wipe an earlier failure from view. */
  async resumeItems(itemIds: readonly string[]): Promise<void> {
    const failures: string[] = [];
    for (const itemId of itemIds) {
      try {
        const res = await this.ipc.control({ action: 'resume-item', itemId });
        if (!res.success) failures.push(res.error?.message ?? 'Failed to send control action');
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.error.set(failures.length ? `${failures.length} of ${itemIds.length} could not be resumed. ${failures[0]}` : null);
  }

  /**
   * Strictly one at a time, including any worker a job goes back to. A long list of stale branches sent together
   * would fill the working-copy limit that running queues also need, and could start many paid sessions at once.
   */
  async retryLandings(itemIds: readonly string[]): Promise<void> {
    if (this.retryProgressSignal()) return;
    this.retryStopped = false;
    let merged = 0;
    let firstFailure = '';
    for (const [done, itemId] of itemIds.entries()) {
      if (this.retryStopped) break;
      this.retryProgressSignal.set({ done, total: itemIds.length, stopping: false });
      const before = this.itemById(itemId);
      // The list was reviewed a while ago: anything that has changed since is left where it is.
      if (before && (before.state !== 'parked' || planQueueIsDiscarded(before) || this.runIsPaused(before) || this.documentBusy(before))) {
        if (before.state === 'landed') merged++;
        continue;
      }
      try {
        const res = await this.ipc.control({ action: 'retry-landing', itemId });
        if (!res.success) {
          firstFailure ||= res.error?.message ?? 'Failed to send control action';
          continue;
        }
        await new Promise<void>(resolve => { this.landingWait = { itemId, updatedAt: before?.updatedAt, resolve }; this.settleLandingWait(); });
        if (this.itemById(itemId)?.state === 'landed') merged++;
      } catch (error) {
        firstFailure ||= error instanceof Error ? error.message : String(error);
      }
    }
    this.retryProgressSignal.set(null);
    const summary = this.retryStopped ? `Stopped after merging ${merged} of ${itemIds.length}.`
      : `Merged ${merged} of ${itemIds.length}. The rest have not merged; check Set aside and Runs.`;
    this.error.set(merged === itemIds.length ? null : `${summary}${firstFailure ? ` ${firstFailure}` : ''}`);
  }

  /**
   * The first press waits for a merge under way but not for a worker. A second press stops waiting altogether, so a
   * job stuck mid-merge cannot trap the page; the queue still owns that merge.
   */
  stopRetrying(): void {
    const alreadyStopping = this.retryProgressSignal()?.stopping;
    this.retryStopped = true;
    this.retryProgressSignal.update(progress => progress && { ...progress, stopping: true });
    if (alreadyStopping) {
      this.landingWait?.resolve();
      this.landingWait = null;
    } else this.settleLandingWait();
  }

  /** The same rule the preview applies through the page's busy documents. */
  private documentBusy(item: PlanQueueItemDto): boolean {
    return this.runsSignal().some(run => (run.status === 'running' || run.status === 'paused') && run.items.some(other =>
      other.id !== item.id && other.documentPath === item.documentPath && !['parked', 'landed', 'skipped'].includes(other.state)));
  }

  private runIsPaused(item: PlanQueueItemDto | undefined): boolean {
    return this.runsSignal().find(run => run.id === item?.runId)?.status === 'paused';
  }

  private itemById(itemId: string): PlanQueueItemDto | undefined {
    return this.runsSignal().flatMap(run => run.items).find(item => item.id === itemId);
  }

  private settleLandingWait(): void {
    const wait = this.landingWait;
    if (!wait) return;
    const item = this.itemById(wait.itemId);
    const finished = item?.state === 'landed' || (item?.state === 'parked' && item.updatedAt !== wait.updatedAt);
    if (!finished && (item?.state === 'landing' || !(this.retryStopped || this.runIsPaused(item)))) return;
    this.landingWait = null;
    wait.resolve();
  }

  /** `git diff --shortstat` of a parked item's branch, fetched on demand. */
  async diffstat(itemId: string): Promise<string> {
    try {
      const res = await this.ipc.diffstat(itemId);
      if (res.success && res.data) return res.data.diffstat;
      this.error.set(res.error?.message ?? 'Failed to load diffstat');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
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
    this.settleLandingWait();
  }
}
