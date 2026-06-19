import { computed, Injectable, signal, inject } from '@angular/core';
import type {
  LoopIterationPayload,
  LoopOutstandingItemPayload,
  LoopRunSummaryPayload,
  LoopStatePayload,
} from '@contracts/schemas/loop';
import {
  LoopIpcService,
  type LoopActivityPayload,
  type LoopOutstandingQuery,
  type LoopOutstandingStatus,
  type LoopStartConfigInput,
} from '../services/ipc/loop-ipc.service';
import type {
  LoopBanner,
  LoopFinalSummary,
  LoopFinalSummaryLastIteration,
  LoopRunningIteration,
} from './loop-store.types';

/**
 * One active loop per chat in v1. The store holds:
 *  - per-chat active loop state (or undefined)
 *  - latest no-progress / claimed-done-but-failed banner per chat
 *  - latest completion summary per chat (for the summary card)
 *
 * Presentational types live in `loop-store.types.ts` (re-exported below) to keep
 * this file under its LOC ceiling.
 */
export type {
  LoopBanner,
  LoopBannerNoProgress,
  LoopBannerClaimedFailed,
  LoopFinalSummary,
  LoopFinalSummaryLastIteration,
  LoopRunningIteration,
} from './loop-store.types';

@Injectable({ providedIn: 'root' })
export class LoopStore {
  private ipc = inject(LoopIpcService);

  /** Map of chatId → active loop state. */
  private activeByChat = signal<Map<string, LoopStatePayload>>(new Map());
  /** Map of chatId → banner. */
  private bannerByChat = signal<Map<string, LoopBanner | null>>(new Map());
  /** Map of chatId → final summary card. */
  private summaryByChat = signal<Map<string, LoopFinalSummary | null>>(new Map());
  /** Map of chatId → recent runs list (for history view if shown). */
  private runsByChat = signal<Map<string, LoopRunSummaryPayload[]>>(new Map());
  /** Map of loopRunId → persisted iteration records. */
  private iterationsByLoop = signal<Map<string, LoopIterationPayload[]>>(new Map());
  /** Map of loopRunId → currently running iteration. */
  private runningIterationByLoop = signal<Map<string, LoopRunningIteration>>(new Map());
  /** Map of loopRunId → recent child CLI activity events. */
  private activityByLoop = signal<Map<string, LoopActivityPayload[]>>(new Map());

  /** Aggregated outstanding items (latest query result). */
  private outstandingItems = signal<LoopOutstandingItemPayload[]>([]);
  /** True while an outstanding query is in flight. */
  private outstandingLoading = signal(false);
  /** The scope of the last outstanding query, replayed when a change event arrives. */
  private lastOutstandingScope: LoopOutstandingQuery = {};

  private wired = false;

  // ────── public selectors ──────

  activeForChat = (chatId: string) =>
    computed(() => this.activeByChat().get(chatId));

  bannerForChat = (chatId: string) =>
    computed(() => this.bannerByChat().get(chatId) ?? null);

  summaryForChat = (chatId: string) =>
    computed(() => this.summaryByChat().get(chatId) ?? null);

  runsForChat = (chatId: string) =>
    computed(() => this.runsByChat().get(chatId) ?? []);

  iterationsForLoop = (loopRunId: string) =>
    computed(() => this.iterationsByLoop().get(loopRunId) ?? []);

  activityForLoop = (loopRunId: string) =>
    computed(() => this.activityByLoop().get(loopRunId) ?? []);

  runningIterationForChat = (chatId: string) =>
    computed(() => {
      const active = this.activeByChat().get(chatId);
      return active ? this.runningIterationByLoop().get(active.id) ?? null : null;
    });

  activityForChat = (chatId: string) =>
    computed(() => {
      const active = this.activeByChat().get(chatId);
      return active ? this.activityByLoop().get(active.id) ?? [] : [];
    });

  isRunningForChat = (chatId: string) =>
    computed(() => {
      const a = this.activeByChat().get(chatId);
      return !!a && (a.status === 'running' || a.status === 'paused');
    });

  /**
   * Set of chatIds that currently have a non-terminal loop (running or paused).
   *
   * This is the "list view" selector — preferred over `isRunningForChat(id)`
   * for places that render many sessions at once (e.g. the project rail), so
   * we don't allocate a new computed per row on every change-detection pass.
   * Consumers do `runningChatIds().has(instanceId)` instead.
   */
  readonly runningChatIds = computed(() => {
    const ids = new Set<string>();
    for (const [chatId, state] of this.activeByChat()) {
      if (state.status === 'running' || state.status === 'paused') {
        ids.add(chatId);
      }
    }
    return ids;
  });

  // ────── outstanding selectors ──────

  /** Latest queried outstanding items. */
  readonly outstanding = this.outstandingItems.asReadonly();
  /** True while an outstanding query is in flight. */
  readonly outstandingIsLoading = this.outstandingLoading.asReadonly();
  /** Count of still-open items in the latest query result. */
  readonly openOutstandingCount = computed(
    () => this.outstandingItems().filter((i) => i.status === 'open').length,
  );

  // ────── lifecycle ──────

  /**
   * Wire IPC listeners once at app startup. Safe to call multiple times.
   */
  ensureWired(): void {
    if (this.wired) return;
    this.wired = true;

    this.ipc.onStateChanged(({ state }) => {
      this.applyState(state);
    });

    this.ipc.onIterationStarted(({ loopRunId, seq, stage }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setRunningIteration({ loopRunId, seq, stage, startedAt: Date.now() });
      this.updateActiveByLoop(loopRunId, (state) => ({
        ...state,
        currentStage: stage as LoopStatePayload['currentStage'],
      }));
    });

    this.ipc.onActivity((activity) => {
      this.addActivity(activity);
    });

    this.ipc.onIterationComplete(({ loopRunId }) => {
      this.clearRunningIteration(loopRunId);
    });

    this.ipc.onPausedNoProgress(({ loopRunId, signal }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, {
        kind: 'no-progress',
        loopRunId,
        signalId: signal.id,
        message: signal.message,
        shownAt: Date.now(),
      });
    });

    this.ipc.onClaimedDoneButFailed(({ loopRunId, signal, failure }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, {
        kind: 'claimed-failed',
        loopRunId,
        signal,
        failure,
        shownAt: Date.now(),
      });
    });

    this.ipc.onTerminalIntentRecorded(({ loopRunId, intent }) => {
      this.addActivity({
        loopRunId,
        seq: intent.iterationSeq,
        stage: this.activeByLoop(loopRunId)?.currentStage ?? '',
        kind: 'status',
        message: `Loop-control ${intent.kind} intent: ${intent.summary}`,
        timestamp: Date.now(),
        detail: { intentId: intent.id, status: intent.status },
      });
    });

    this.ipc.onTerminalIntentRejected(({ loopRunId, intent, reason }) => {
      this.addActivity({
        loopRunId,
        seq: intent.iterationSeq,
        stage: this.activeByLoop(loopRunId)?.currentStage ?? '',
        kind: 'error',
        message: `Loop-control ${intent.kind} intent rejected: ${reason}`,
        timestamp: Date.now(),
        detail: { intentId: intent.id, status: intent.status },
      });
    });

    this.ipc.onFreshEyesReviewStarted(({ loopRunId, signal }) => {
      const state = this.activeByLoop(loopRunId);
      this.addActivity({
        loopRunId,
        seq: state?.totalIterations ?? 0,
        stage: state?.currentStage ?? '',
        kind: 'status',
        message: `Fresh-eyes review started for ${signal}`,
        timestamp: Date.now(),
        detail: { signal },
      });
    });

    this.ipc.onFreshEyesReviewPassed(({ loopRunId, signal, reviewersUsed, nonBlockingFindings, summary }) => {
      const state = this.activeByLoop(loopRunId);
      this.addActivity({
        loopRunId,
        seq: state?.totalIterations ?? 0,
        stage: state?.currentStage ?? '',
        kind: 'status',
        message: `Fresh-eyes review passed for ${signal}`,
        timestamp: Date.now(),
        detail: { signal, reviewersUsed, nonBlockingFindings, summary },
      });
    });

    this.ipc.onFreshEyesReviewFailed(({ loopRunId, signal, error }) => {
      const state = this.activeByLoop(loopRunId);
      this.addActivity({
        loopRunId,
        seq: state?.totalIterations ?? 0,
        stage: state?.currentStage ?? '',
        kind: 'error',
        message: `Fresh-eyes review failed for ${signal}: ${error}`,
        timestamp: Date.now(),
        detail: { signal, error },
      });
    });

    this.ipc.onFreshEyesReviewBlocked(({ loopRunId, signal, reviewersUsed, blockingFindings, summary }) => {
      const state = this.activeByLoop(loopRunId);
      this.addActivity({
        loopRunId,
        seq: state?.totalIterations ?? 0,
        stage: state?.currentStage ?? '',
        kind: 'input_required',
        message: `Fresh-eyes review blocked ${signal}`,
        timestamp: Date.now(),
        detail: { signal, reviewersUsed, blockingFindings, summary },
      });
    });

    this.ipc.onCompleted(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    // LF-7: clear any lingering banner when a loop lands needs-review (the
    // terminal LoopState arrives via onStateChanged → applyState).
    this.ipc.onCompletedNeedsReview(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    this.ipc.onFailed(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    this.ipc.onCapReached(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (chatId) this.setBanner(chatId, null);
    });

    this.ipc.onError(({ loopRunId }) => {
      const chatId = this.findChatIdForLoop(loopRunId);
      if (!chatId) return;
      this.setBanner(chatId, null);
    });

    // Outstanding items persisted / changed → refresh the panel using the
    // scope of the last query so the open count + list stay live.
    this.ipc.onOutstandingChanged(() => {
      void this.loadOutstanding(this.lastOutstandingScope);
    });
  }

  // ────── outstanding commands ──────

  /** Load aggregated outstanding items into the store (remembers the scope so
   *  change events can replay it). */
  async loadOutstanding(
    scope: LoopOutstandingQuery = {},
  ): Promise<void> {
    this.lastOutstandingScope = scope;
    this.outstandingLoading.set(true);
    try {
      const res = await this.ipc.listOutstanding(scope);
      if (res.success && res.data) {
        this.outstandingItems.set(res.data.items);
      }
    } finally {
      this.outstandingLoading.set(false);
    }
  }

  /** Mark one outstanding item resolved / dismissed / re-opened, optionally saving
   *  the human's answer (`response` undefined keeps the existing answer; '' clears it). */
  async setOutstandingStatus(id: string, status: LoopOutstandingStatus, response?: string): Promise<boolean> {
    const res = await this.ipc.setOutstandingStatus(id, status, response);
    if (!(res.success && res.data?.ok)) return false;
    const now = Date.now();
    this.outstandingItems.update((items) =>
      items.map((item) =>
        item.id === id
          ? {
            ...item, status, resolvedAt: status === 'open' ? null : now, updatedAt: now,
            ...(response === undefined ? {} : { userResponse: response }),
          }
          : item,
      ),
    );
    return true;
  }

  /** Mark many outstanding items at once (e.g. "Resolve all"). Issues the IPC
   *  calls in parallel and applies a single optimistic update for the whole
   *  batch; a change event re-syncs from the source of truth. Returns the
   *  number of items the main process confirmed. */
  async setOutstandingStatusBulk(ids: string[], status: LoopOutstandingStatus): Promise<number> {
    if (ids.length === 0) return 0;
    const results = await Promise.all(
      ids.map(async (id) => {
        const res = await this.ipc.setOutstandingStatus(id, status);
        return res.success && res.data?.ok === true ? id : null;
      }),
    );
    const confirmed = new Set(results.filter((id): id is string => id !== null));
    if (confirmed.size > 0) {
      const now = Date.now();
      this.outstandingItems.update((items) =>
        items.map((item) =>
          confirmed.has(item.id)
            ? { ...item, status, resolvedAt: status === 'open' ? null : now, updatedAt: now }
            : item,
        ),
      );
    }
    return confirmed.size;
  }

  /** Export open outstanding items to a consolidated OUTSTANDING.md. */
  async exportOutstanding(
    workspaceCwd: string,
    destPath?: string,
    chatId?: string,
  ): Promise<{ path: string; itemCount: number } | null> {
    const res = await this.ipc.exportOutstanding(workspaceCwd, destPath, chatId);
    return res.success && res.data ? res.data : null;
  }

  /** Start a fresh loop run applying the saved answers on the scope's open items.
   *  Returns the new run + how many answers were applied, or an error message. */
  async resumeOutstandingWithAnswers(
    chatId: string,
    workspaceCwd: string,
  ): Promise<{ ok: true; appliedCount: number } | { ok: false; error: string }> {
    const res = await this.ipc.resumeWithAnswers(chatId, workspaceCwd);
    if (res.success && res.data) return { ok: true, appliedCount: res.data.appliedCount };
    return { ok: false, error: res.error?.message ?? 'Resume failed' };
  }

  // ────── commands ──────

  /** Set of chatIds with a start-IPC currently in flight. Prevents the
   *  store from issuing two LOOP_START requests for the same chat — the
   *  main process also enforces this, but failing fast in the renderer
   *  saves a round-trip and makes the error message obvious. */
  private startingByChat = new Set<string>();

  async start(
    chatId: string,
    config: LoopStartConfigInput,
    attachments?: { name: string; data: Uint8Array }[],
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.startingByChat.has(chatId)) {
      return { ok: false, error: 'A loop is already starting for this chat — please wait.' };
    }
    if (this.activeByChat().has(chatId)) {
      return { ok: false, error: 'A loop is already active for this chat — cancel it first.' };
    }
    this.startingByChat.add(chatId);
    try {
      const r = await this.ipc.start(chatId, config, attachments);
      if (!r.success) return { ok: false, error: r.error?.message ?? 'unknown error' };
      if (r.data?.state) this.upsertActive(r.data.state);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.startingByChat.delete(chatId);
    }
  }

  async pause(loopRunId: string): Promise<void> {
    const response = await this.ipc.pause(loopRunId);
    this.applyControlResponse(loopRunId, response, 'pause');
  }

  async resume(loopRunId: string): Promise<void> {
    const response = await this.ipc.resume(loopRunId);
    const ok = this.applyControlResponse(loopRunId, response, 'resume');
    const chatId = this.findChatIdForLoop(loopRunId);
    if (ok && chatId) this.setBanner(chatId, null);
  }

  async intervene(loopRunId: string, message: string): Promise<void> {
    const response = await this.ipc.intervene(loopRunId, message);
    const ok = this.applyControlResponse(loopRunId, response, 'hint');
    if (ok) {
      this.addControlActivity(loopRunId, 'status', 'Hint queued for the next loop iteration');
    }
  }

  async cancel(loopRunId: string): Promise<void> {
    const response = await this.ipc.cancel(loopRunId);
    const ok = this.applyControlResponse(loopRunId, response, 'stop');
    if (!ok) return;
    const state = this.activeByLoop(loopRunId);
    if (!state) return;
    this.applyState({
      ...state,
      status: 'cancelled',
      endedAt: Date.now(),
      endReason: 'user cancelled',
    });
  }

  /**
   * LF-7: operator accepts a paused, done-but-ungated run. The main process
   * runs verify if configured (pass → completed, fail → stays paused) or lands
   * `completed-needs-review` when there is no verify command. The terminal
   * state arrives via the normal `loop:state-changed` broadcast applied by
   * `applyControlResponse`; we only surface a clear failure message when the
   * accept was rejected (e.g. verify failed).
   */
  async acceptCompletion(loopRunId: string): Promise<{ ok: boolean }> {
    const response = await this.ipc.acceptCompletion(loopRunId);
    if (response.data?.state) this.applyState(response.data.state);
    if (!response.success) {
      this.addControlActivity(loopRunId, 'error', `Accept failed: ${response.error?.message ?? 'unknown error'}`);
      return { ok: false };
    }
    if (response.data?.ok === false) {
      this.addControlActivity(
        loopRunId,
        'status',
        'Accept did not complete the loop — verify may have failed or the loop was not awaiting review.',
      );
      return { ok: false };
    }
    return { ok: true };
  }

  async refreshHistory(chatId: string, limit = 25): Promise<void> {
    const r = await this.ipc.listRunsForChat(chatId, limit);
    if (r.success && r.data?.runs) {
      const map = new Map(this.runsByChat());
      map.set(chatId, r.data.runs);
      this.runsByChat.set(map);
    }
  }

  async refreshIterations(loopRunId: string): Promise<void> {
    const r = await this.ipc.getIterations(loopRunId);
    if (r.success && r.data?.iterations) {
      const map = new Map(this.iterationsByLoop());
      map.set(loopRunId, r.data.iterations);
      this.iterationsByLoop.set(map);
    }
  }

  dismissSummary(chatId: string): void {
    const map = new Map(this.summaryByChat());
    map.set(chatId, null);
    this.summaryByChat.set(map);
  }

  dismissBanner(chatId: string): void {
    this.setBanner(chatId, null);
  }

  // ────── private mutators ──────

  private upsertActive(state: LoopStatePayload): void {
    const map = new Map(this.activeByChat());
    map.set(state.chatId, state);
    this.activeByChat.set(map);
  }

  private clearActive(chatId: string): void {
    const current = this.activeByChat();
    if (!current.has(chatId)) return; // already cleared — no-op
    const map = new Map(current);
    map.delete(chatId);
    this.activeByChat.set(map);
  }

  private applyState(state: LoopStatePayload): void {
    if (this.isTerminalStatus(state.status)) {
      // The loop is over — clear any lingering paused-no-progress / claimed-failed
      // banner now. Otherwise the orange bar stays on screen with buttons
      // (Resume anyway / Stop / Inject hint) that all early-return because
      // `active()` becomes undefined the moment we call clearActive() below,
      // making the bar look broken to the user.
      //
      // Must run BEFORE clearActive(), because findChatIdForLoop() (used by
      // the per-event clearers like onCancelled) walks activeByChat and
      // would no longer be able to map this loopRunId back to a chat.
      this.setBanner(state.chatId, null);

      this.upsertSummary(state.chatId, {
        loopRunId: state.id,
        status: state.status,
        reason: state.endReason ?? state.status,
        iterations: state.totalIterations,
        tokens: state.totalTokens,
        costCents: state.totalCostCents,
        startedAt: state.startedAt,
        endedAt: state.endedAt ?? Date.now(),
        initialPrompt: state.config.initialPrompt,
        iterationPrompt: state.config.iterationPrompt,
        lastIteration: snapshotLastIteration(state.lastIteration),
      });
      this.clearRunningIteration(state.id);
      this.clearActive(state.chatId);
      return;
    }

    this.upsertActive(state);
    // If we re-entered a non-terminal state, leave the no-progress banner
    // alone. It is intentionally user-dismissed by Resume/Stop/Dismiss.
  }

  private updateActiveByLoop(loopRunId: string, update: (state: LoopStatePayload) => LoopStatePayload): void {
    const map = new Map(this.activeByChat());
    for (const [chatId, state] of map) {
      if (state.id !== loopRunId) continue;
      map.set(chatId, update(state));
      this.activeByChat.set(map);
      return;
    }
  }

  private activeByLoop(loopRunId: string): LoopStatePayload | undefined {
    for (const state of this.activeByChat().values()) {
      if (state.id === loopRunId) return state;
    }
    return undefined;
  }

  private upsertSummary(chatId: string, summary: LoopFinalSummary): void {
    const map = new Map(this.summaryByChat());
    map.set(chatId, summary);
    this.summaryByChat.set(map);
  }

  private setBanner(chatId: string, banner: LoopBanner | null): void {
    const current = this.bannerByChat();
    const has = current.has(chatId);
    // No-op guards: clearing a banner that isn't set, or re-setting the same
    // reference (commonly null on terminal/dismiss) shouldn't wake subscribers.
    if ((banner === null && !has) || (has && current.get(chatId) === banner)) {
      return;
    }
    const map = new Map(current);
    map.set(chatId, banner);
    this.bannerByChat.set(map);
  }

  private setRunningIteration(iteration: LoopRunningIteration): void {
    const map = new Map(this.runningIterationByLoop());
    map.set(iteration.loopRunId, iteration);
    this.runningIterationByLoop.set(map);
  }

  private clearRunningIteration(loopRunId: string): void {
    const current = this.runningIterationByLoop();
    if (!current.has(loopRunId)) return; // nothing running — no-op
    const map = new Map(current);
    map.delete(loopRunId);
    this.runningIterationByLoop.set(map);
  }

  private addActivity(activity: LoopActivityPayload): void {
    const map = new Map(this.activityByLoop());
    const next = [...(map.get(activity.loopRunId) ?? []), activity].slice(-80);
    map.set(activity.loopRunId, next);
    this.activityByLoop.set(map);
  }

  private applyControlResponse(
    loopRunId: string,
    response: {
      success: boolean;
      data?: { ok?: boolean; state?: LoopStatePayload | null };
      error?: { message: string };
    },
    action: 'pause' | 'resume' | 'hint' | 'stop',
  ): boolean {
    if (!response.success) {
      this.addControlActivity(loopRunId, 'error', `Loop ${action} failed: ${response.error?.message ?? 'unknown error'}`);
      return false;
    }

    if (response.data?.state) {
      this.applyState(response.data.state);
    }

    if (response.data?.ok === false) {
      this.addControlActivity(loopRunId, 'error', `Loop ${action} was rejected by the main process`);
      return false;
    }

    return true;
  }

  private addControlActivity(
    loopRunId: string,
    kind: LoopActivityPayload['kind'],
    message: string,
  ): void {
    const state = this.activeByLoop(loopRunId);
    this.addActivity({
      loopRunId,
      seq: state?.totalIterations ?? 0,
      stage: state?.currentStage ?? '',
      kind,
      message,
      timestamp: Date.now(),
    });
  }

  private findChatIdForLoop(loopRunId: string): string | null {
    for (const [chatId, state] of this.activeByChat()) {
      if (state.id === loopRunId) return chatId;
    }
    return null;
  }

  private isTerminalStatus(status: LoopStatePayload['status']): status is LoopFinalSummary['status'] {
    return (
      status === 'completed'
      || status === 'completed-needs-review'
      || status === 'cancelled'
      || status === 'failed'
      || status === 'cap-reached'
      || status === 'error'
      || status === 'no-progress'
      || status === 'provider-limit'
    );
  }
}

/** Truncate the agent's final response so the summary card never blows
 *  out — the full text is always available via Inspect trace. */
const MAX_SUMMARY_OUTPUT_CHARS = 4_000;
/** Truncate verify command output similarly. Verify dumps can be huge
 *  (full test logs); the trace inspector keeps the unabridged copy. */
const MAX_SUMMARY_VERIFY_CHARS = 1_500;

function snapshotLastIteration(
  iteration: LoopStatePayload['lastIteration'],
): LoopFinalSummaryLastIteration | undefined {
  if (!iteration) return undefined;
  return {
    seq: iteration.seq,
    stage: iteration.stage,
    outputExcerpt: truncateForSummary(iteration.outputExcerpt, MAX_SUMMARY_OUTPUT_CHARS),
    filesChanged: iteration.filesChanged.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    testPassCount: iteration.testPassCount,
    testFailCount: iteration.testFailCount,
    verifyStatus: iteration.verifyStatus,
    verifyOutputExcerpt: truncateForSummary(iteration.verifyOutputExcerpt, MAX_SUMMARY_VERIFY_CHARS),
    progressVerdict: iteration.progressVerdict,
  };
}

function truncateForSummary(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 18).trimEnd()}\n…(truncated)`;
}
