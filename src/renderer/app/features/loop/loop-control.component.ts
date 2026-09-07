import { SlicePipe } from '@angular/common';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { chipTooltipFor, metricStripTooltipFor, resumeTooltipFor } from './loop-tooltip-copy.util';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  signal,
  untracked,
} from '@angular/core';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { ReactionIpcService } from '../../core/services/ipc/reaction-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { LoopStore } from '../../core/state/loop.store';
import { buildHonestyChips, buildLoopAuditChips } from './loop-audit-chips.util';
import { buildRunConfigSummary, iterationCapLabel } from './loop-run-config-summary.util';
import {
  activeCostUsage,
  activeTokenUsage,
  currentIterationLabel,
  isUsageUnsettled,
} from './loop-usage-copy.util';
import {
  activityKindLabel,
  buildInspectorProgress,
  completionGateSteps,
  displayIterationNumber,
  effectiveLoopExecutionPath,
  formatCostCents,
  humanDuration,
  humanTokens,
  loopErrorSummary,
  loopIterationDuration,
  loopPauseReason,
  loopStatusPill,
  managedWorktreeStatus,
  progressVerdictView,
  shortTime,
  summaryHasDistinctIterationPrompt as hasDistinctIterationPrompt,
  summarizeToolDetail,
  terminalStatusLabel,
} from './loop-formatters.util';
import { LoopInspectorProgressComponent } from './loop-inspector-progress.component';
import { LoopIssueCardComponent } from './loop-issue-card.component';
import { LoopIterationEvidenceComponent } from './loop-iteration-evidence.component';
import {
  buildLoopIssueView,
  progressVerdictHeaderWord,
} from './loop-issue-diagnosis.util';
import { LoopPastRunsPanelComponent } from './loop-past-runs-panel.component';
import { PromptModalComponent } from '../../shared/components/prompt-modal/prompt-modal.component';
import { RlmStorageMaintenanceComponent } from './rlm-storage-maintenance.component';
import { VerificationRunHistoryComponent } from './verification-run-history.component';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { LoopCausalTimelineComponent } from './loop-causal-timeline.component';
import { loopTimelineForRun, timelineRecoveryTarget } from './loop-control-timeline';
import { LoopFreshEyesFindingsPanelComponent } from './loop-fresh-eyes-findings-panel.component';
import { freshEyesFindingsDetail } from './loop-fresh-eyes-findings-panel.util';
import { LoopBranchEpisodeCardComponent } from './loop-branch-episode-card.component';

/**
 * Shows the Loop Mode HUD for one chat:
 *  - banner       — pause / verify-failed alerts (when applicable)
 *  - active strip — running/paused loop status + activity feed
 *  - past runs    — persistent history with copy/reattempt actions
 *  - summary      — "Loop ended" card, in-session, with copy actions
 *
 * Past runs and the summary card both display prompt-related controls,
 * but they target different user goals: the summary is the just-ended
 * notification (dismissable, in-memory), while the past-runs panel is
 * the durable history surface that survives reload. They live as
 * separate components so each one's UI state (collapsed/expanded,
 * "Copied ✓" flashes) is owned by the component that uses it and is
 * naturally reset on chat switch via component instance lifecycle.
 */
@Component({
  selector: 'app-loop-control',
  standalone: true,
  imports: [LoopBranchEpisodeCardComponent, LoopFreshEyesFindingsPanelComponent, LoopCausalTimelineComponent, AioTooltipDirective, SlicePipe, LoopInspectorProgressComponent, LoopIssueCardComponent, LoopIterationEvidenceComponent, LoopPastRunsPanelComponent, PromptModalComponent, RlmStorageMaintenanceComponent, VerificationRunHistoryComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './loop-control.component.html',
  styleUrl: './loop-control.component.scss',
})
export class LoopControlComponent implements OnDestroy {
  chatId = input<string | null>(null);

  protected store = inject(LoopStore);
  private clipboard = inject(CLIPBOARD_SERVICE);
  private reactionIpc = inject(ReactionIpcService);
  private toast = inject(ToastService);
  private pollScheduler = inject(RendererPollSchedulerService);

  /** Per-instance reactions armed state. Tri-state: null = not yet loaded. */
  protected reactionsArmed = signal<boolean | null>(null);

  /** Per-instance auto-merge opt-in. Only meaningful while armed. */
  protected autoMergeAllowed = signal<boolean>(false);

  /** Cleanup handle for the global reaction-event subscription. */
  private reactionEventUnsub: (() => void) | null = null;

  /** 1Hz tick that drives elapsed-time recomputation in the active strip. */
  private tick = signal(0);
  private stopTick: (() => void) | null = null;

  /** Summary card UI state — owned by this component because the card
   *  itself is owned here. */
  protected promptExpanded = signal(false);
  protected copiedSummaryPart = signal<'initial' | 'iteration' | 'response' | null>(null);
  protected inspectorExpanded = signal(false);
  protected inspectorLoading = signal(false);
  protected hintModalOpen = signal(false);
  /** Task 18: whether the hint modal is queuing a plain hint or a `follow-up`. */
  protected hintMode = signal<'hint' | 'follow-up'>('hint');
  private copyClearHandle: ReturnType<typeof setTimeout> | null = null;
  private lastSummaryRunId: string | null = null;
  private lastInspectableLoopId: string | null = null;

  /** Latest terminal summary's run id, propagated to the past-runs panel
   *  so it knows when to re-pull history. Null while no summary is shown. */
  lastTerminalSummaryId = computed<string | null>(() => this.summary()?.loopRunId ?? null);

  active = computed(() => {
    const id = this.chatId();
    return id ? this.store.activeForChat(id)() : undefined;
  });

  /** B5 — four stable steps plus what is blocking. Derivation lives next door. */
  causalTimeline = computed(() => loopTimelineForRun(this.active()));

  onTimelineRecovery(id: string): void {
    if (timelineRecoveryTarget(id) === 'resume') void this.onResumeAnyway();
  }

  banner = computed(() => {
    const id = this.chatId();
    return id ? this.store.bannerForChat(id)() : null;
  });

  summary = computed(() => {
    const id = this.chatId();
    return id ? this.store.summaryForChat(id)() : null;
  });

  inspectableLoopId = computed(() => this.active()?.id ?? this.banner()?.loopRunId ?? this.summary()?.loopRunId ?? null);
  controlLoopId = computed(() => this.active()?.id ?? this.banner()?.loopRunId ?? null);

  /** Live ping-pong runtime state for the active loop (null unless armed). */
  pingPong = computed(() => this.active()?.pingPong ?? null);
  /** Configured ping-pong round cap (default 15). */
  pingPongMaxRounds = computed(
    () => this.active()?.config.completion.crossModelReview?.pingPong?.maxRounds ?? 15,
  );
  /** Count of unresolved (open / regression) ledger issues. */
  pingPongOpenIssues = computed(
    () => (this.pingPong()?.ledger ?? []).filter((i) => i.status === 'open' || i.status === 'regression').length,
  );

  // ── LF-8: legible status model ─────────────────────────────────────────────
  /** Always-on status pill (RUNNING / NEEDS REVIEW / PAUSED · NO PROGRESS / …). */
  statusPill = computed(() => {
    const a = this.active();
    if (!a) return null;
    const b = this.banner();
    return loopStatusPill({
      status: a.status,
      endedAt: a.endedAt,
      manualReviewOnly: a.manualReviewOnly,
      lastCompletionOutcome: a.lastCompletionOutcome,
      bannerKind: b?.kind ?? null,
      bannerSignalId: b?.kind === 'no-progress' ? b.signalId : null,
    });
  });

  /** The reason a paused loop is paused (awaiting-review / no-progress / blocked / paused). */
  pauseKind = computed(() => {
    const a = this.active();
    if (!a || a.status !== 'paused') return null;
    const b = this.banner();
    return loopPauseReason({
      manualReviewOnly: a.manualReviewOnly,
      lastCompletionOutcome: a.lastCompletionOutcome,
      bannerKind: b?.kind ?? null,
      bannerSignalId: b?.kind === 'no-progress' ? b.signalId : null,
    });
  });

  /**
   * Latest completed-iteration verdict, labelled explicitly during an in-flight
   * iteration. The strip renders alongside the pause banner, so while a banner
   * is up the chip tooltip must use the banner's diagnosis — otherwise a
   * blocked pause shows the real blocker in the banner and a stale iteration
   * WARN in the tooltip right below it.
   */
  latestVerdict = computed(() => {
    const active = this.active();
    const value = active?.lastIteration?.progressVerdict;
    if (!value) return null;
    const headline = (this.banner() ? this.bannerIssueView() : this.issueView())?.headline;
    return progressVerdictView(value, active.status === 'running', headline);
  });

  /**
   * True only for a pause the loop imposed on itself over progress. A manual
   * Pause and an awaiting-review pause are `status === 'paused'` too, so
   * keying off status alone would describe those as "paused because it could
   * not prove progress" — a lie. (A provider-limit park is already excluded:
   * it has its own status.) The banner check covers the window where the
   * banner event has landed but the paused state has not.
   */
  private progressPause = computed(() => {
    if (this.banner()?.kind === 'no-progress') return true;
    const kind = this.pauseKind();
    return kind === 'no-progress' || kind === 'blocked';
  });

  /** Operator diagnosis for the last WARN/CRITICAL iteration (null when healthy). */
  issueView = computed(() => {
    const active = this.active();
    const last = active?.lastIteration;
    if (!active || !last) return null;
    return buildLoopIssueView({
      verdict: last.progressVerdict,
      signals: last.progressSignals,
      running: active.status === 'running',
      paused: this.progressPause(),
      blocked: this.pauseKind() === 'blocked',
      autoUnstickInFlight: Boolean(
        active.autoUnstick && active.autoUnstick.seq === last.seq,
      ),
      reviewDriven: active.config.completion.mode === 'review-driven'
        || Boolean(active.config.completion.crossModelReview?.pingPong?.enabled),
    });
  });

  /** Show the diagnosis card only when a pause banner is not already covering it. */
  showIssueCard = computed(() => this.banner() ? null : this.issueView());

  /**
   * Diagnosis for the pause banner. Unlike the card, this leads with the
   * signal that actually caused the pause. A BLOCKED / resource-governor /
   * preflight pause is raised out of band and never lands in the iteration's
   * `progressSignals`, so building the banner from the iteration alone would
   * headline a stale WARN and throw the real blocker text away.
   */
  bannerIssueView = computed(() => {
    const active = this.active();
    const b = this.banner();
    const pauseSignal = b?.kind === 'no-progress'
      // A pause signal is CRITICAL by construction at every emit site; the
      // store's banner shape does not carry the verdict.
      ? { id: b.signalId, verdict: 'CRITICAL', message: b.message }
      : undefined;
    const last = active?.lastIteration;
    if (!active || (!last && !pauseSignal)) return null;
    return buildLoopIssueView({
      verdict: last?.progressVerdict ?? 'OK',
      signals: last?.progressSignals ?? [],
      pauseSignal,
      running: active.status === 'running',
      paused: this.progressPause(),
      blocked: this.pauseKind() === 'blocked',
    });
  });

  /** Completion-gate stepper steps for the active loop. */
  gateSteps = computed(() => {
    const a = this.active();
    if (!a) return [];
    return completionGateSteps({
      status: a.status,
      verifyStatus: a.lastIteration?.verifyStatus,
      renameObserved: a.completedFileRenameObserved,
      requireRename: a.config.completion.requireCompletedFileRename,
      manualReviewOnly: a.manualReviewOnly,
      freshEyesEnabled: a.config.completion.crossModelReview?.enabled ?? false,
      lastCompletionOutcome: a.lastCompletionOutcome,
    });
  });

  /** Show the gate stepper once the loop has attempted completion or is paused. */
  showGate = computed(() => {
    const a = this.active();
    if (!a) return false;
    return a.status === 'paused' || a.lastCompletionOutcome !== undefined;
  });

  auditStatus = computed(() => {
    const a = this.active();
    if (!a) return null;
    return buildLoopAuditChips({
      audit: a.config.audit,
      preflight: a.preflight,
      latestFinalAudit: a.latestFinalAudit,
    });
  });

  honestyChips = computed(() => {
    const a = this.active();
    if (!a) return [];
    return buildHonestyChips({
      autoUnstick: a.autoUnstick,
      capWrapUpIntent: a.capWrapUpIntent,
      nonConvergence: a.nonConvergence,
      parkedLeaves: a.parkedLeaves,
    });
  });

  /** UX1/UX3 tooltip copy. Rules live in `loop-tooltip-copy.util.ts`. */
  protected copy = copyFor;
  protected chipTooltip = chipTooltipFor;
  protected readonly resumeTooltip = computed(() => resumeTooltipFor(this.pauseKind()));
  protected readonly metricStripTooltip = computed(() =>
    metricStripTooltipFor(Boolean(this.active()), this.active()?.inferredPhase));

  runConfigSummary = computed(() => buildRunConfigSummary(this.active()));

  runningIteration = computed(() => {
    const id = this.chatId();
    return id ? this.store.runningIterationForChat(id)() : null;
  });

  activity = computed(() => {
    const id = this.chatId();
    return id ? this.store.activityForChat(id)() : [];
  });

  recentActivity = computed(() => this.activity().slice(-8).reverse());
  fullActivity = computed(() => {
    const loopId = this.inspectableLoopId();
    return loopId ? this.store.activityForLoop(loopId)().slice().reverse() : [];
  });
  inspectorIterations = computed(() => {
    const loopId = this.inspectableLoopId();
    return loopId ? this.store.iterationsForLoop(loopId)().slice().reverse() : [];
  });
  /** Current work-state anchor for the inspector's execution ledger. Active
   * loops expose it directly; historical runs pick their newest persisted
   * iteration after the inspector fetch completes. */
  inspectedWorkHash = computed(() => {
    const loopId = this.inspectableLoopId();
    const active = this.active();
    if (active?.id === loopId) return active.lastIteration?.workHash ?? null;
    return this.inspectorIterations()[0]?.workHash ?? null;
  });
  latestIterationSeq = computed(() => this.inspectorIterations()[0]?.seq ?? -1);

  /**
   * Live summary of the iteration that is *currently running* — derived from
   * the activity stream for the loop, scoped to the running iteration's seq.
   * This is what fills the inspector while iteration 0 is still in flight and
   * no iteration record has been persisted yet (records are written on
   * iteration end), so the trace isn't just "No persisted records".
   */
  currentIterationStats = computed(() => {
    const running = this.runningIteration();
    const loopId = this.inspectableLoopId();
    if (!running || !loopId) return null;
    const events = this.store.activityForLoop(loopId)().filter((e) => e.seq === running.seq);
    const toolEvents = events.filter((e) => e.kind === 'tool_use');
    const toolName = (detail?: Record<string, unknown>, message?: string): string => {
      const name = detail && typeof detail['name'] === 'string' ? detail['name'] : '';
      return name || (message ?? '').replace(/^Using tool:\s*/i, '').trim() || 'tool';
    };
    const counts = new Map<string, number>();
    for (const e of toolEvents) {
      const name = toolName(e.detail, e.message);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const lastTool = toolEvents.length > 0 ? toolEvents[toolEvents.length - 1] : null;
    const lastAssistant = [...events].reverse().find((e) => e.kind === 'assistant')?.message ?? null;
    return {
      seq: running.seq,
      stage: running.stage,
      toolCount: toolEvents.length,
      toolBreakdown: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}×${count}`)
        .join(', '),
      lastToolName: lastTool ? toolName(lastTool.detail, lastTool.message) : '',
      lastToolArg: lastTool ? summarizeToolDetail(lastTool.detail) : '',
      lastAssistant,
    };
  });

  elapsed = computed(() => {
    this.tick();
    const a = this.active();
    if (!a) return 0;
    return Date.now() - a.startedAt;
  });

  currentIterationElapsed = computed(() => {
    this.tick();
    const running = this.runningIteration();
    if (!running) return 0;
    return Date.now() - running.startedAt;
  });

  /**
   * At-a-glance answer to "is this loop nearly finished, or hasn't it
   * started?" — surfaced at the top of the inspector. A loop terminates when
   * the completion gate clears OR any *capped* budget is exhausted, so we show
   * a progress bar per cap (iterations / wall-time / tokens / cost); the
   * fullest bar is the binding constraint. Uncapped budgets show the running
   * total with no bar. Recomputes on the 1Hz `tick` via `elapsed()` so the
   * time bar advances live. Null when no loop is active (the summary card above
   * already shows the final tally for a just-ended run).
   */
  inspectorProgress = computed(() => {
    const a = this.active();
    if (!a) return null;
    const pill = this.statusPill();
    const running = this.runningIteration();
    return buildInspectorProgress({
      status: a.status,
      statusPillKind: pill?.kind ?? null,
      statusPillLabel: pill?.label ?? null,
      totalIterations: a.totalIterations,
      totalTokens: a.totalTokens,
      totalCostCents: a.totalCostCents,
      currentStage: a.currentStage,
      iterationsOnCurrentStage: a.iterationsOnCurrentStage,
      completionAttempts: a.completionAttempts,
      lastCompletionOutcome: a.lastCompletionOutcome,
      runningSeq: running ? running.seq : null,
      elapsedMs: this.elapsed(),
      caps: a.config.caps,
    });
  });

  constructor() {
    this.store.ensureWired();
    this.stopTick = this.pollScheduler.register(() => this.tick.update((t) => t + 1), 1000);

    // Subscribe globally to reaction events and show a toast when the event
    // is for the currently-viewed instance, so firings are visible in the UI.
    this.reactionEventUnsub = this.reactionIpc.onReactionEvent((raw) => {
      const ev = raw as { instanceId?: string; message?: string; priority?: string };
      if (!ev.instanceId || ev.instanceId !== this.chatId()) return;
      const isUrgent = ev.priority === 'urgent' || ev.priority === 'action';
      const msg = ev.message ?? 'Reaction triggered';
      this.toast.show(msg, isUrgent ? 'error' : 'success');
    });

    // Load per-instance reactions armed state whenever the chat changes.
    effect(() => {
      const id = this.chatId();
      if (!id) {
        untracked(() => { this.reactionsArmed.set(null); this.autoMergeAllowed.set(false); });
        return;
      }
      untracked(() => {
        void this.reactionIpc.getState(id).then((res) => {
          if (res.success && res.data != null) {
            const data = res.data as { armed?: boolean; autoMergeAllowed?: boolean };
            this.reactionsArmed.set(data.armed ?? false);
            this.autoMergeAllowed.set(data.autoMergeAllowed ?? false);
          } else {
            this.reactionsArmed.set(false);
            this.autoMergeAllowed.set(false);
          }
        });
      });
    });

    // Reset the summary card's prompt-expansion + Copied flag when a
    // new summary appears, so a fresh loop run doesn't inherit the
    // previous run's UI state.
    effect(() => {
      const s = this.summary();
      const runId = s?.loopRunId ?? null;
      if (runId === this.lastSummaryRunId) return;
      untracked(() => {
        this.lastSummaryRunId = runId;
        this.promptExpanded.set(false);
        this.copiedSummaryPart.set(null);
        if (this.copyClearHandle) {
          clearTimeout(this.copyClearHandle);
          this.copyClearHandle = null;
        }
      });
    });

    // Reset the inspector when the loop being inspected changes. Otherwise
    // a reused chat component could show trace controls from a prior run.
    effect(() => {
      const loopId = this.inspectableLoopId();
      if (loopId === this.lastInspectableLoopId) return;
      untracked(() => {
        this.lastInspectableLoopId = loopId;
        this.inspectorExpanded.set(false);
        this.inspectorLoading.set(false);
      });
    });

    // When the user opens the trace, keep the persisted iteration records
    // fresh enough to explain pause/verify/no-progress decisions.
    effect(() => {
      const loopId = this.inspectableLoopId();
      const expanded = this.inspectorExpanded();
      if (!loopId || !expanded) return;
      untracked(() => {
        void this.refreshInspector(loopId);
      });
    });
  }

  ngOnDestroy(): void {
    this.stopTick?.();
    if (this.copyClearHandle) clearTimeout(this.copyClearHandle);
    this.reactionEventUnsub?.();
  }

  // ────── summary card actions ──────

  async onCopyInitialPrompt(prompt: string): Promise<void> {
    await this.copySummaryPrompt(prompt, 'initial', 'first-iteration prompt');
  }

  async onCopyIterationPrompt(prompt: string): Promise<void> {
    await this.copySummaryPrompt(prompt, 'iteration', 'continuation directive');
  }

  /** Copy the agent's full final response (the closing message shown in the
   *  summary card). Shares the "Copied ✓" flash plumbing with the prompt
   *  copy buttons via {@link copySummaryPrompt}. */
  async onCopyFinalResponse(response: string): Promise<void> {
    await this.copySummaryPrompt(response, 'response', 'final response');
  }

  /** Tightened helper used by the "Copy prompt" / "Copy continuation"
   *  buttons. Shared logic kept here (rather than in the formatters
   *  util) because it touches Angular signals + the clipboard service. */
  private async copySummaryPrompt(
    prompt: string,
    which: 'initial' | 'iteration' | 'response',
    label: string,
  ): Promise<void> {
    if (!prompt) return;
    const result = await this.clipboard.copyText(prompt, { label });
    if (!result.ok) return;
    this.copiedSummaryPart.set(which);
    if (this.copyClearHandle) clearTimeout(this.copyClearHandle);
    this.copyClearHandle = setTimeout(() => {
      this.copiedSummaryPart.set(null);
      this.copyClearHandle = null;
    }, 1800);
  }

  protected readonly summaryHasDistinctIterationPrompt = hasDistinctIterationPrompt;

  async onToggleReactionsArmed(): Promise<void> {
    const id = this.chatId();
    if (!id) return;
    const next = !(this.reactionsArmed() ?? false);
    this.reactionsArmed.set(next);
    await this.reactionIpc.setArmed(id, next);
    // Disarming revokes auto-merge in the engine; mirror that in the UI.
    if (!next && this.autoMergeAllowed()) {
      this.autoMergeAllowed.set(false);
    }
  }

  async onToggleAutoMerge(): Promise<void> {
    const id = this.chatId();
    if (!id) return;
    // Auto-merge requires arming; guard in the UI as well as the engine.
    if (!this.reactionsArmed()) return;
    const next = !this.autoMergeAllowed();
    this.autoMergeAllowed.set(next);
    const res = await this.reactionIpc.setAutoMergeAllowed(id, next);
    // Reconcile with the effective state the engine reports (it can refuse).
    if (res.success && res.data != null) {
      const data = res.data as { allowed?: boolean };
      this.autoMergeAllowed.set(data.allowed ?? false);
    }
  }

  // ────── loop control actions ──────

  async onPause(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.pause(a.id);
  }

  async onResumeAnyway(): Promise<void> {
    const loopId = this.controlLoopId(); if (!loopId) return;
    await this.store.resume(loopId);
  }

  async onStop(): Promise<void> {
    const loopId = this.controlLoopId(); if (!loopId) return;
    await this.store.cancel(loopId);
  }

  async onPingPongSkipRound(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.pingPongSkipRound(a.id);
  }

  async onPingPongForceArbitration(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.pingPongForceArbitration(a.id);
  }

  /** LF-8 → LF-7: accept a paused, done-but-ungated run in one click. */
  async onAcceptCompletion(): Promise<void> {
    const loopId = this.controlLoopId(); if (!loopId) return;
    await this.store.acceptCompletion(loopId);
  }

  /** Opens the in-app hint modal. (window.prompt is a no-op in the
   *  sandboxed Electron renderer, so the prompt must be in-app.) */
  onInjectHint(): void {
    if (!this.controlLoopId()) return;
    this.hintMode.set('hint');
    this.hintModalOpen.set(true);
  }

  /** Task 18: queue a `follow-up` — a message the loop runs before it finishes. */
  onQueueFollowUp(): void {
    if (!this.controlLoopId()) return;
    this.hintMode.set('follow-up');
    this.hintModalOpen.set(true);
  }

  async onHintSubmitted(message: string): Promise<void> {
    this.hintModalOpen.set(false);
    const loopId = this.controlLoopId();
    const trimmed = message.trim();
    if (!loopId || !trimmed) return;
    await this.store.intervene(loopId, trimmed, this.hintMode() === 'follow-up' ? 'follow-up' : undefined);
  }

  /** N4 — structured findings for an activity row, or null for every other row. */
  protected readonly findingsDetail = freshEyesFindingsDetail;

  /** Send the selected findings back through the existing intervention path. */
  async onFixFindings(message: string): Promise<void> {
    const loopId = this.controlLoopId();
    if (!loopId || !message.trim()) return;
    await this.store.intervene(loopId, message, 'steer');
  }

  onHintCancelled(): void {
    this.hintModalOpen.set(false);
  }

  onDismissBanner(): void {
    const id = this.chatId();
    if (id) this.store.dismissBanner(id);
  }

  onDismissSummary(): void {
    const id = this.chatId();
    if (id) this.store.dismissSummary(id);
  }

  onToggleInspector(): void {
    this.inspectorExpanded.update((expanded) => !expanded);
  }

  async onRefreshInspector(): Promise<void> {
    const loopId = this.inspectableLoopId();
    if (!loopId) return;
    await this.refreshInspector(loopId);
  }

  private async refreshInspector(loopRunId: string): Promise<void> {
    if (this.inspectorLoading()) return;
    this.inspectorLoading.set(true);
    try {
      await this.store.refreshIterations(loopRunId);
    } finally {
      this.inspectorLoading.set(false);
    }
  }

  private readonly usageUnsettled = computed(
    () => isUsageUnsettled(Boolean(this.runningIteration()), this.active()?.status),
  );

  protected readonly currentIterationLabel = computed(() => currentIterationLabel(
    Boolean(this.runningIteration()),
    this.currentIterationElapsed(),
    this.usageUnsettled(),
    // L4: only while the run is live — a finished run's last phase is history.
    this.active()?.status === 'running' ? this.active()?.inferredPhase ?? null : null,
  ));

  protected readonly activeTokenUsage = (t: number) => activeTokenUsage(t, this.usageUnsettled());
  protected readonly activeCostUsage = (c: number) => activeCostUsage(c, this.usageUnsettled());

  protected readonly duration = humanDuration;
  protected readonly tokens = humanTokens;
  protected readonly cost = formatCostCents;
  protected readonly time = shortTime;
  protected readonly kindLabel = activityKindLabel;
  protected readonly toolDetail = summarizeToolDetail;
  protected readonly iterationNumber = displayIterationNumber;
  protected readonly executionPath = effectiveLoopExecutionPath;
  protected readonly iterationCapLabel = iterationCapLabel;
  protected readonly summaryStatusLabel = terminalStatusLabel;
  protected readonly managedStatus = managedWorktreeStatus;
  protected readonly verdictHeader = progressVerdictHeaderWord;
  protected readonly iterationDuration = loopIterationDuration;
  protected readonly errorSummary = loopErrorSummary;
}
