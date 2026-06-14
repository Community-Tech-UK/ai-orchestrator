import { SlicePipe } from '@angular/common';
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
import type { LoopIterationPayload } from '@contracts/schemas/loop';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { ReactionIpcService } from '../../core/services/ipc/reaction-ipc.service';
import { ToastService } from '../../core/services/toast.service';
import { LoopStore } from '../../core/state/loop.store';
import {
  activityKindLabel,
  completionGateSteps,
  formatCostCents,
  humanDuration,
  humanTokens,
  loopPauseReason,
  loopStatusPill,
  shortTime,
  summarizeToolDetail,
  terminalStatusLabel,
} from './loop-formatters.util';
import { LoopPastRunsPanelComponent } from './loop-past-runs-panel.component';
import { PromptModalComponent } from '../../shared/components/prompt-modal/prompt-modal.component';

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
  imports: [SlicePipe, LoopPastRunsPanelComponent, PromptModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (banner(); as b) {
      <div
        class="loop-banner"
        [class.warn]="b.kind === 'no-progress' && pauseKind() !== 'awaiting-review'"
        [class.review]="pauseKind() === 'awaiting-review'"
        [class.danger]="b.kind === 'claimed-failed' && pauseKind() !== 'awaiting-review'"
      >
        @if (pauseKind() === 'awaiting-review') {
          <span class="loop-banner-title">Awaiting your review — loop thinks it's done</span>
          <span class="loop-banner-msg">
            @if (b.kind === 'claimed-failed') {
              {{ b.failure }}
            } @else {
              The loop can't auto-confirm completion, so it's waiting on you.
              Review the work, then accept or keep iterating.
            }
          </span>
          <span class="loop-banner-actions">
            <button type="button" class="banner-accept" (click)="onAcceptCompletion()">Accept as complete</button>
            <button type="button" (click)="onToggleInspector()">Inspect</button>
            <button type="button" (click)="onInjectHint()">Keep iterating (hint)</button>
            <button type="button" (click)="onStop()">Stop</button>
          </span>
        } @else {
          @switch (b.kind) {
            @case ('no-progress') {
              <span class="loop-banner-title">{{ pauseKind() === 'blocked' ? 'Loop blocked — needs you' : 'Loop paused — no progress' }}</span>
              <span class="loop-banner-msg">{{ b.message }} <code>(signal {{ b.signalId }})</code></span>
              <span class="loop-banner-actions">
                <button type="button" (click)="onToggleInspector()">Inspect</button>
                <button type="button" (click)="onInjectHint()">Inject hint</button>
                <button type="button" (click)="onResumeAnyway()">Resume anyway</button>
                <button type="button" (click)="onStop()">Stop</button>
              </span>
            }
            @case ('claimed-failed') {
              <span class="loop-banner-title">Completion not accepted</span>
              <span class="loop-banner-msg">Loop reported done via <code>{{ b.signal }}</code>: {{ b.failure | slice:0:280 }}…</span>
              <span class="loop-banner-actions">
                <button type="button" (click)="onToggleInspector()">Inspect</button>
                <button type="button" (click)="onInjectHint()">Inject hint</button>
                <button type="button" (click)="onDismissBanner()">Dismiss</button>
              </span>
            }
          }
        }
      </div>
    }

    @if (active(); as a) {
      <div class="loop-status" [class.paused]="a.status === 'paused'">
        @if (statusPill(); as pill) {
          <span class="ls-pill" [attr.data-pill]="pill.kind">{{ pill.label }}</span>
        }
        @if (latestVerdict(); as verdict) {
          <span class="ls-verdict" [attr.data-verdict]="verdict" title="Latest progress verdict">{{ verdict }}</span>
        }
        <span class="ls-text">
          {{ runningIteration() ? ('iteration ' + runningIteration()!.seq + ' running') : (a.totalIterations + ' iterations run') }}/{{ iterationCapLabel(a.config.caps.maxIterations) }}
          · stage {{ runningIteration()?.stage ?? a.currentStage }}
          · current {{ runningIteration() ? duration(currentIterationElapsed()) : 'idle' }}
          · total {{ duration(elapsed()) }}
          · {{ tokens(a.totalTokens) }}
          · {{ cost(a.totalCostCents) }}
        </span>
        <span class="ls-actions">
          @if (a.status === 'running') {
            <button type="button" (click)="onPause()" title="Pause loop">Pause</button>
          } @else if (a.status === 'paused') {
            @if (pauseKind() === 'awaiting-review') {
              <button type="button" class="ls-accept" (click)="onAcceptCompletion()" title="Accept the work as complete">Accept as complete</button>
            }
            <button type="button" (click)="onResumeAnyway()" title="Resume loop">Resume</button>
          }
          <button type="button" (click)="onToggleInspector()" title="Show loop trace">{{ inspectorExpanded() ? 'Hide trace' : 'Inspect' }}</button>
          <button type="button" (click)="onInjectHint()" title="Inject a hint into next iteration">Hint</button>
          <button type="button" class="ls-stop" (click)="onStop()" title="Stop loop">Stop</button>
        </span>
      </div>

      @if (showGate()) {
        <div class="loop-gate" title="Completion gate — what the loop must clear to stop">
          @for (step of gateSteps(); track step.key) {
            @if (step.state !== 'skipped') {
              <span class="lg-step" [attr.data-state]="step.state">{{ step.label }}</span>
            }
          }
        </div>
      }

      @if (reactionsArmed() !== null) {
        <div class="loop-reactions">
          <label class="lr-toggle">
            <input
              type="checkbox"
              [checked]="reactionsArmed() === true"
              (change)="onToggleReactionsArmed()"
            />
            Auto-react to CI &amp; review events
          </label>
          @if (reactionsArmed()) {
            <span class="lr-hint">Armed — CI failures and review requests will trigger a fix prompt.</span>
            <label class="lr-toggle lr-toggle-nested">
              <input
                type="checkbox"
                [checked]="autoMergeAllowed()"
                (change)="onToggleAutoMerge()"
              />
              Allow auto-merge when approved &amp; green
            </label>
            @if (autoMergeAllowed()) {
              <span class="lr-hint lr-hint-warn">
                Auto-merge armed — an approved PR with passing CI and no conflicts will be squash-merged automatically (re-checked live before merging).
              </span>
            }
          }
        </div>
      }

      <details class="loop-runcfg">
        <summary>Run configuration</summary>
        <div class="loop-runcfg-rows">
          @for (row of runConfigSummary(); track row.label) {
            <div class="lrc-row">
              <span class="lrc-label">{{ row.label }}</span>
              <span class="lrc-value">{{ row.value }}</span>
            </div>
          }
        </div>
      </details>

      <div class="loop-activity">
        <div class="la-title">
          <span>Live loop activity</span>
          <code>{{ a.config.workspaceCwd }}</code>
        </div>
        @if (activity().length > 0) {
          <div class="la-list">
            @for (event of recentActivity(); track event.timestamp + event.kind + event.message) {
              <div class="la-row" [class.error]="event.kind === 'error'" [class.warn]="event.kind === 'stream-idle' || event.kind === 'input_required'">
                <span class="la-time">{{ time(event.timestamp) }}</span>
                <span class="la-kind">{{ kindLabel(event.kind) }}</span>
                <span class="la-message">
                  {{ event.message }}
                  @if (event.kind === 'tool_use' && toolDetail(event.detail); as d) {
                    <span class="la-tool-arg">{{ d }}</span>
                  }
                </span>
              </div>
            }
          </div>
        } @else {
          <div class="la-empty">Waiting for child CLI output. If this stays empty, the child has not emitted any stream events yet.</div>
        }
      </div>

    }

    @if (inspectorExpanded() && inspectableLoopId()) {
        <div class="loop-inspector">
          <div class="li-head">
            <span>Loop trace</span>
            <span class="li-head-actions">
              @if (inspectorLoading()) {
                <span class="li-loading">Refreshing…</span>
              }
              <button type="button" (click)="onRefreshInspector()" [disabled]="inspectorLoading()">Refresh</button>
            </span>
          </div>

          <div class="li-section-title">Iterations</div>
          @if (currentIterationStats(); as cur) {
            <div class="li-current">
              <div class="li-current-head">
                <span>iter {{ cur.seq }} · {{ cur.stage }} · in progress…</span>
                <span>{{ duration(currentIterationElapsed()) }} · {{ cur.toolCount }} tool calls</span>
              </div>
              @if (cur.toolBreakdown) {
                <div class="li-current-line"><span class="li-current-label">Tools</span> {{ cur.toolBreakdown }}</div>
              }
              @if (cur.lastToolArg) {
                <div class="li-current-line">
                  <span class="li-current-label">Latest</span> {{ cur.lastToolName }}
                  <code class="li-current-arg">{{ cur.lastToolArg }}</code>
                </div>
              }
              @if (cur.lastAssistant) {
                <div class="li-current-line li-current-assistant">{{ cur.lastAssistant }}</div>
              }
            </div>
          }
          @if (inspectorIterations().length > 0) {
            <div class="li-iterations">
              @for (iter of inspectorIterations(); track iter.id) {
                <details class="li-iter" [open]="iter.seq === latestIterationSeq()">
                  <summary>
                    <span>iter {{ iter.seq }} · {{ iter.stage }} · {{ iter.progressVerdict }}</span>
                    <span>{{ duration(iterationDuration(iter)) }} · {{ tokens(iter.tokens) }} · {{ cost(iter.costCents) }}</span>
                  </summary>
                  <div class="li-grid">
                    <div>
                      <div class="li-subtitle">Output excerpt</div>
                      <pre>{{ iter.outputExcerpt || 'No output excerpt captured.' }}</pre>
                    </div>
                    <div>
                      <div class="li-subtitle">Evidence</div>
                      <p>{{ signalSummary(iter) }}</p>
                      <p>{{ testSummary(iter) }}</p>
                      <p>{{ filesPreview(iter) }}</p>
                      @if (iter.verifyOutputExcerpt) {
                        <div class="li-subtitle">Verify output</div>
                        <pre>{{ iter.verifyOutputExcerpt }}</pre>
                      }
                      @if (iter.errors.length > 0) {
                        <div class="li-subtitle">Errors</div>
                        <pre>{{ errorSummary(iter) }}</pre>
                      }
                    </div>
                  </div>
                </details>
              }
            </div>
          } @else if (!currentIterationStats()) {
            <div class="li-empty">No persisted iteration records are available yet. The live activity feed below still shows child CLI events as they arrive.</div>
          }

          <div class="li-section-title">Activity log</div>
          @if (fullActivity().length > 0) {
            <div class="li-activity">
              @for (event of fullActivity(); track event.timestamp + event.kind + event.message) {
                <div class="li-activity-row" [class.error]="event.kind === 'error'" [class.warn]="event.kind === 'stream-idle' || event.kind === 'input_required'">
                  <span class="la-time">{{ time(event.timestamp) }}</span>
                  <span class="la-kind">{{ kindLabel(event.kind) }}</span>
                  <span class="li-activity-message">
                    {{ event.message }}
                    @if (event.kind === 'tool_use' && toolDetail(event.detail); as d) {
                      <span class="li-tool-arg">{{ d }}</span>
                    }
                  </span>
                </div>
              }
            </div>
          } @else {
            <div class="li-empty">No live activity has been received for this loop in this renderer session.</div>
          }
        </div>
      }

    <app-loop-past-runs-panel
      [chatId]="chatId()"
      [loopRunning]="!!active()"
      [terminalSummaryRunId]="lastTerminalSummaryId()"
    />

    @if (summary(); as s) {
      <div class="loop-summary" [attr.data-status]="s.status">
        <div class="lsum-title">
          <span class="lsum-title-text">
            Loop ended — <span class="lsum-status-pill" [attr.data-status]="s.status">{{ summaryStatusLabel(s.status) }}</span>
          </span>
          <button type="button" class="lsum-close" (click)="onDismissSummary()" aria-label="Dismiss">×</button>
        </div>
        <div class="lsum-line">
          {{ s.iterations }} iterations · {{ duration(s.endedAt - s.startedAt) }} · {{ tokens(s.tokens) }} · {{ cost(s.costCents) }}
        </div>
        <div class="lsum-reason">Reason: {{ s.reason }}</div>

        @if (s.lastIteration; as li) {
          <div class="lsum-recap">
            <div class="lsum-recap-stats">
              <span class="lsum-stat">
                <span class="lsum-stat-label">Files changed</span>
                <span class="lsum-stat-value">{{ li.filesChanged.length }}</span>
              </span>
              @if (li.testPassCount !== null || li.testFailCount !== null) {
                <span class="lsum-stat">
                  <span class="lsum-stat-label">Tests</span>
                  <span class="lsum-stat-value" [class.bad]="(li.testFailCount ?? 0) > 0">
                    {{ li.testPassCount ?? 0 }} passed{{ (li.testFailCount ?? 0) > 0 ? ', ' + li.testFailCount + ' failed' : '' }}
                  </span>
                </span>
              }
              @if (li.verifyStatus !== 'not-run') {
                <span class="lsum-stat">
                  <span class="lsum-stat-label">Verify</span>
                  <span class="lsum-stat-value" [class.bad]="li.verifyStatus === 'failed'" [class.ok]="li.verifyStatus === 'passed'">
                    {{ li.verifyStatus }}
                  </span>
                </span>
              }
            </div>

            @if (li.filesChanged.length > 0) {
              <ul class="lsum-files">
                @for (file of li.filesChanged | slice:0:8; track file.path) {
                  <li class="lsum-file">
                    <code>{{ file.path }}</code>
                    <span class="lsum-file-diff">
                      <span class="lsum-file-add">+{{ file.additions }}</span>
                      <span class="lsum-file-del">-{{ file.deletions }}</span>
                    </span>
                  </li>
                }
                @if (li.filesChanged.length > 8) {
                  <li class="lsum-file lsum-file-more">+{{ li.filesChanged.length - 8 }} more</li>
                }
              </ul>
            }

            @if (li.outputExcerpt) {
              <div class="lsum-recap-output">
                <div class="lsum-recap-label">Final response (iter {{ li.seq }} · {{ li.stage }})</div>
                <pre class="lsum-recap-pre">{{ li.outputExcerpt }}</pre>
              </div>
            }
          </div>
        }

        <div class="lsum-prompt-actions">
          <button
            type="button"
            class="lsum-prompt-btn"
            (click)="onToggleInspector()"
            [attr.aria-expanded]="inspectorExpanded()"
          >{{ inspectorExpanded() ? 'Hide trace' : 'Inspect trace' }}</button>
          <button
            type="button"
            class="lsum-prompt-btn"
            (click)="promptExpanded.set(!promptExpanded())"
            [attr.aria-expanded]="promptExpanded()"
          >{{ promptExpanded() ? 'Hide prompt' : 'Show prompt' }}</button>
          <button
            type="button"
            class="lsum-prompt-btn"
            (click)="onCopyInitialPrompt(s.initialPrompt)"
            [disabled]="!s.initialPrompt"
            [title]="copiedSummaryPart() === 'initial' ? 'Copied!' : 'Copy the iteration-0 prompt'"
          >{{ copiedSummaryPart() === 'initial' ? 'Copied ✓' : 'Copy prompt' }}</button>
          @if (summaryHasDistinctIterationPrompt(s)) {
            <button
              type="button"
              class="lsum-prompt-btn"
              (click)="onCopyIterationPrompt(s.iterationPrompt!)"
              [title]="copiedSummaryPart() === 'iteration' ? 'Copied!' : 'Copy the iteration-1+ continuation directive'"
            >{{ copiedSummaryPart() === 'iteration' ? 'Copied ✓' : 'Copy continuation' }}</button>
          }
        </div>
        @if (promptExpanded()) {
          <div class="lsum-prompt-block">
            <div class="lsum-prompt-label">Iteration 0 prompt</div>
            <pre class="lsum-prompt-pre">{{ s.initialPrompt }}</pre>
            @if (summaryHasDistinctIterationPrompt(s)) {
              <div class="lsum-prompt-label">Iteration 1+ continuation</div>
              <pre class="lsum-prompt-pre">{{ s.iterationPrompt }}</pre>
            }
          </div>
        }
      </div>
    }

    <app-prompt-modal
      [isOpen]="hintModalOpen()"
      title="Inject a hint"
      message="This is added to the next loop iteration as a steering instruction. The loop keeps running."
      placeholder="e.g. Skip councils that need a login; move on to the next one."
      confirmLabel="Inject hint"
      [multiline]="true"
      (submitted)="onHintSubmitted($event)"
      (cancelled)="onHintCancelled()"
    />
  `,
  styleUrl: './loop-control.component.scss',
})
export class LoopControlComponent implements OnDestroy {
  chatId = input<string | null>(null);

  protected store = inject(LoopStore);
  private clipboard = inject(CLIPBOARD_SERVICE);
  private reactionIpc = inject(ReactionIpcService);
  private toast = inject(ToastService);

  /** Per-instance reactions armed state. Tri-state: null = not yet loaded. */
  protected reactionsArmed = signal<boolean | null>(null);

  /** Per-instance auto-merge opt-in. Only meaningful while armed. */
  protected autoMergeAllowed = signal<boolean>(false);

  /** Cleanup handle for the global reaction-event subscription. */
  private reactionEventUnsub: (() => void) | null = null;

  /** 1Hz tick that drives elapsed-time recomputation in the active strip. */
  private tick = signal(0);
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Summary card UI state — owned by this component because the card
   *  itself is owned here. */
  protected promptExpanded = signal(false);
  protected copiedSummaryPart = signal<'initial' | 'iteration' | null>(null);
  protected inspectorExpanded = signal(false);
  protected inspectorLoading = signal(false);
  protected hintModalOpen = signal(false);
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

  // ── LF-8: legible status model ─────────────────────────────────────────────
  /** Always-on status pill (RUNNING / NEEDS REVIEW / PAUSED · NO PROGRESS / …). */
  statusPill = computed(() => {
    const a = this.active();
    if (!a) return null;
    const b = this.banner();
    return loopStatusPill({
      status: a.status,
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

  /** Latest per-iteration progress verdict (OK / WARN / CRITICAL), or null. */
  latestVerdict = computed(() => this.active()?.lastIteration?.progressVerdict ?? null);

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

  /**
   * LF-8: a compact, read-only summary of the ACTIVE run's config — so the user
   * can see what spawned the running loop (provider, context strategy, caps,
   * verify, enabled options) without re-opening the start panel. Collapsed by
   * default in the strip.
   */
  runConfigSummary = computed<{ label: string; value: string }[]>(() => {
    const a = this.active();
    if (!a) return [];
    const c = a.config;
    const cost = c.caps.maxCostCents === null ? 'no cap' : formatCostCents(c.caps.maxCostCents);
    const tokenCap = c.caps.maxTokens === null ? 'no token cap' : humanTokens(c.caps.maxTokens);
    const flags: string[] = [];
    if (c.completion.requireCompletedFileRename) flags.push('rename-gate');
    if (c.completion.runVerifyTwice) flags.push('verify×2');
    if (c.completion.crossModelReview?.enabled) flags.push('fresh-eyes');
    if (c.context?.compaction.enabled) flags.push('context-recycle');
    if (c.exploration?.enabled) flags.push('branch-select');
    if (c.plan?.regenerateOnStall) flags.push('regen-on-stall');
    if (c.semanticProgress?.enabled) flags.push('semantic-progress');
    if (c.allowDestructiveOps) flags.push('destructive-ops');
    return [
      { label: 'Provider', value: c.provider },
      { label: 'Context', value: c.contextStrategy },
      { label: 'Start stage', value: c.initialStage },
      { label: 'Caps', value: `${this.iterationCapLabel(c.caps.maxIterations)} iters · ${humanDuration(c.caps.maxWallTimeMs)} · ${tokenCap} · ${cost}` },
      { label: 'Verify', value: c.completion.verifyCommand || (a.manualReviewOnly ? 'manual review (no command)' : 'auto-detected') },
      { label: 'Options', value: flags.length ? flags.join(', ') : 'defaults' },
    ];
  });

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

  constructor() {
    this.store.ensureWired();
    this.tickHandle = setInterval(() => this.tick.update((t) => t + 1), 1000);

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
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.copyClearHandle) clearTimeout(this.copyClearHandle);
    this.reactionEventUnsub?.();
  }

  // ────── summary card actions ──────

  async onCopyInitialPrompt(prompt: string): Promise<void> {
    await this.copySummaryPrompt(prompt, 'initial', 'iteration-0 prompt');
  }

  async onCopyIterationPrompt(prompt: string): Promise<void> {
    await this.copySummaryPrompt(prompt, 'iteration', 'continuation directive');
  }

  /** Tightened helper used by the "Copy prompt" / "Copy continuation"
   *  buttons. Shared logic kept here (rather than in the formatters
   *  util) because it touches Angular signals + the clipboard service. */
  private async copySummaryPrompt(
    prompt: string,
    which: 'initial' | 'iteration',
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

  /** Centralized predicate so the template doesn't repeat the
   *  null/empty/equality dance — and so a future contract change
   *  (e.g. iterationPrompt becoming required) can be absorbed in one
   *  place. */
  summaryHasDistinctIterationPrompt(s: { initialPrompt: string; iterationPrompt?: string | null }): boolean {
    return (
      typeof s.iterationPrompt === 'string'
      && s.iterationPrompt.length > 0
      && s.iterationPrompt !== s.initialPrompt
    );
  }

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

  /** LF-8 → LF-7: accept a paused, done-but-ungated run in one click. */
  async onAcceptCompletion(): Promise<void> {
    const loopId = this.controlLoopId(); if (!loopId) return;
    await this.store.acceptCompletion(loopId);
  }

  /** Opens the in-app hint modal. (window.prompt is a no-op in the
   *  sandboxed Electron renderer, so the prompt must be in-app.) */
  onInjectHint(): void {
    if (!this.controlLoopId()) return;
    this.hintModalOpen.set(true);
  }

  async onHintSubmitted(message: string): Promise<void> {
    this.hintModalOpen.set(false);
    const loopId = this.controlLoopId();
    const trimmed = message.trim();
    if (!loopId || !trimmed) return;
    await this.store.intervene(loopId, trimmed);
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

  protected iterationDuration(iteration: LoopIterationPayload): number {
    return (iteration.endedAt ?? Date.now()) - iteration.startedAt;
  }

  protected testSummary(iteration: LoopIterationPayload): string {
    if (iteration.testPassCount === null && iteration.testFailCount === null) {
      return 'Tests: not reported';
    }
    return `Tests: ${iteration.testPassCount ?? 0} passed, ${iteration.testFailCount ?? 0} failed`;
  }

  protected filesPreview(iteration: LoopIterationPayload): string {
    if (iteration.filesChanged.length === 0) return 'Files changed: none reported';
    const preview = iteration.filesChanged
      .slice(0, 6)
      .map((file) => `${file.path} (+${file.additions}/-${file.deletions})`)
      .join(', ');
    const suffix = iteration.filesChanged.length > 6 ? `, +${iteration.filesChanged.length - 6} more` : '';
    return `Files changed: ${preview}${suffix}`;
  }

  protected signalSummary(iteration: LoopIterationPayload): string {
    const progress = iteration.progressSignals.length > 0
      ? iteration.progressSignals.map((signal) => `${signal.id}:${signal.verdict}`).join(', ')
      : 'none';
    const completion = iteration.completionSignalsFired.length > 0
      ? iteration.completionSignalsFired
        .map((signal) => `${signal.id}:${signal.sufficient ? 'sufficient' : 'insufficient'}`)
        .join(', ')
      : 'none';
    return `Signals: progress ${progress}; completion ${completion}; verify ${iteration.verifyStatus}`;
  }

  protected errorSummary(iteration: LoopIterationPayload): string {
    return iteration.errors
      .map((error) => `${error.bucket}: ${error.excerpt}`)
      .join('\n\n');
  }

  // ────── presentational helpers (delegate to pure utils) ──────
  // Methods rather than direct util references so the template binds
  // cleanly without `import {…}` inside the @Component decorator.

  protected duration(ms: number): string { return humanDuration(ms); }
  protected tokens(n: number): string    { return humanTokens(n); }
  protected cost(cents: number): string  { return formatCostCents(cents); }
  protected time(ts: number): string     { return shortTime(ts); }
  protected kindLabel(kind: string): string { return activityKindLabel(kind); }
  protected toolDetail(detail?: Record<string, unknown>): string { return summarizeToolDetail(detail); }
  protected iterationCapLabel(maxIterations: number | null): string { return maxIterations === null ? '∞' : String(maxIterations); }
  protected summaryStatusLabel(status: 'completed' | 'completed-needs-review' | 'cancelled' | 'failed' | 'cap-reached' | 'error' | 'no-progress' | 'provider-limit'): string {
    return terminalStatusLabel(status);
  }
}
