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
import { LoopStore } from '../../core/state/loop.store';
import {
  activityKindLabel,
  formatCostCents,
  humanDuration,
  humanTokens,
  shortTime,
  terminalStatusLabel,
} from './loop-formatters.util';
import { LoopPastRunsPanelComponent } from './loop-past-runs-panel.component';

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
  imports: [SlicePipe, LoopPastRunsPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (banner(); as b) {
      <div class="loop-banner" [class.warn]="b.kind === 'no-progress'" [class.danger]="b.kind === 'claimed-failed'">
        @switch (b.kind) {
          @case ('no-progress') {
            <span class="loop-banner-title">Loop paused — no progress</span>
            <span class="loop-banner-msg">{{ b.message }} <code>(signal {{ b.signalId }})</code></span>
            <span class="loop-banner-actions">
              <button type="button" (click)="onToggleInspector()">Inspect</button>
              <button type="button" (click)="onInjectHint()">Inject hint</button>
              <button type="button" (click)="onResumeAnyway()">Resume anyway</button>
              <button type="button" (click)="onStop()">Stop</button>
            </span>
          }
          @case ('claimed-failed') {
            <span class="loop-banner-title">Verify failed</span>
            <span class="loop-banner-msg">Loop reported done via <code>{{ b.signal }}</code> but verify failed: {{ b.failure | slice:0:280 }}…</span>
            <span class="loop-banner-actions">
              <button type="button" (click)="onToggleInspector()">Inspect</button>
              <button type="button" (click)="onInjectHint()">Inject hint</button>
              <button type="button" (click)="onDismissBanner()">Dismiss</button>
            </span>
          }
        }
      </div>
    }

    @if (active(); as a) {
      <div class="loop-status" [class.paused]="a.status === 'paused'">
        <span class="ls-icon">{{ a.status === 'paused' ? '⏸' : '🔁' }}</span>
        <span class="ls-text">
          Loop · {{ runningIteration() ? ('iter ' + runningIteration()!.seq + ' running') : ('iter ' + a.totalIterations + ' complete') }}/{{ a.config.caps.maxIterations }}
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
            <button type="button" (click)="onResumeAnyway()" title="Resume loop">Resume</button>
          }
          <button type="button" (click)="onToggleInspector()" title="Show loop trace">{{ inspectorExpanded() ? 'Hide trace' : 'Inspect' }}</button>
          <button type="button" (click)="onInjectHint()" title="Inject a hint into next iteration">Hint</button>
          <button type="button" class="ls-stop" (click)="onStop()" title="Stop loop">Stop</button>
        </span>
      </div>

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
                <span class="la-message">{{ event.message }}</span>
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
          } @else {
            <div class="li-empty">No persisted iteration records are available yet. The live activity feed below still shows child CLI events as they arrive.</div>
          }

          <div class="li-section-title">Activity log</div>
          @if (fullActivity().length > 0) {
            <div class="li-activity">
              @for (event of fullActivity(); track event.timestamp + event.kind + event.message) {
                <div class="li-activity-row" [class.error]="event.kind === 'error'" [class.warn]="event.kind === 'stream-idle' || event.kind === 'input_required'">
                  <span class="la-time">{{ time(event.timestamp) }}</span>
                  <span class="la-kind">{{ kindLabel(event.kind) }}</span>
                  <span class="li-activity-message">{{ event.message }}</span>
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
      <div class="loop-summary">
        <div class="lsum-title">
          Loop ended — {{ summaryStatusLabel(s.status) }}
          <button type="button" class="lsum-close" (click)="onDismissSummary()" aria-label="Dismiss">×</button>
        </div>
        <div class="lsum-line">
          {{ s.iterations }} iterations · {{ duration(s.endedAt - s.startedAt) }} · {{ tokens(s.tokens) }} · {{ cost(s.costCents) }}
        </div>
        <div class="lsum-reason">Reason: {{ s.reason }}</div>
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
  `,
  styles: [`
    .loop-status {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      padding: 6px 10px; margin: 6px 0;
      border: 1px solid rgba(95,142,224,0.45); background: rgba(95,142,224,0.1);
      border-radius: 6px; font-size: 12px;
    }
    .loop-status.paused { border-color: rgba(247,192,122,0.6); background: rgba(247,192,122,0.08); }
    .ls-text { flex: 1; }
    .ls-actions { display: flex; gap: 4px; }
    .ls-actions button {
      padding: 3px 8px; font-size: 11px; font: inherit;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
      cursor: pointer;
    }
    .ls-stop { color: #f78c7c !important; }

    .loop-activity {
      margin: -2px 0 6px;
      padding: 8px 10px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.035);
      border-radius: 6px;
      font-size: 11px;
    }
    .la-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      opacity: 0.75;
      font-weight: 600;
    }
    .la-title code {
      max-width: 58%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 400;
    }
    .la-list { display: flex; flex-direction: column; gap: 3px; }
    .la-row {
      display: grid;
      grid-template-columns: 54px 72px minmax(0, 1fr);
      gap: 8px;
      line-height: 1.35;
      opacity: 0.82;
    }
    .la-row.error { color: #f78c7c; }
    .la-row.warn { color: #f7c07a; }
    .la-time, .la-kind {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      opacity: 0.7;
      text-transform: uppercase;
    }
    .la-message {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .la-empty { opacity: 0.55; }

    .loop-inspector {
      margin: 6px 0;
      padding: 10px;
      border: 1px solid rgba(95,142,224,0.28);
      background: rgba(95,142,224,0.055);
      border-radius: 6px;
      font-size: 11px;
    }
    .li-head,
    .li-head-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .li-head {
      margin-bottom: 8px;
      font-weight: 600;
    }
    .li-head button {
      padding: 3px 8px;
      font: inherit;
      background: rgba(255,255,255,0.05);
      color: inherit;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 4px;
      cursor: pointer;
    }
    .li-head button:disabled { opacity: 0.45; cursor: not-allowed; }
    .li-loading { opacity: 0.6; font-weight: 400; }
    .li-section-title {
      margin: 8px 0 4px;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.06em;
      opacity: 0.62;
      text-transform: uppercase;
    }
    .li-iterations {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .li-iter {
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 5px;
      background: rgba(0,0,0,0.18);
    }
    .li-iter summary {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      padding: 7px 8px;
      cursor: pointer;
      font-weight: 600;
    }
    .li-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 10px;
      padding: 0 8px 8px;
    }
    .li-subtitle {
      margin: 6px 0 3px;
      font-weight: 600;
      opacity: 0.76;
    }
    .li-iter p {
      margin: 0 0 4px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
    .li-iter pre {
      margin: 0;
      max-height: 260px;
      overflow: auto;
      padding: 7px;
      border-radius: 4px;
      background: rgba(0,0,0,0.28);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 10px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .li-empty {
      padding: 7px 8px;
      border: 1px dashed rgba(255,255,255,0.1);
      border-radius: 4px;
      opacity: 0.62;
    }
    .li-activity {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 300px;
      overflow: auto;
    }
    .li-activity-row {
      display: grid;
      grid-template-columns: 54px 72px minmax(0, 1fr);
      gap: 8px;
      line-height: 1.4;
      opacity: 0.86;
    }
    .li-activity-row.error { color: #f78c7c; }
    .li-activity-row.warn { color: #f7c07a; }
    .li-activity-message {
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    @media (max-width: 760px) {
      .li-grid { grid-template-columns: 1fr; }
      .li-iter summary { flex-direction: column; }
    }

    .loop-banner {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
      padding: 8px 10px; margin: 6px 0;
      border-radius: 6px; font-size: 12px;
      border: 1px solid; line-height: 1.4;
    }
    .loop-banner.warn { background: rgba(247,192,122,0.12); border-color: rgba(247,192,122,0.45); }
    .loop-banner.danger { background: rgba(247,124,124,0.12); border-color: rgba(247,124,124,0.45); }
    .loop-banner-title { font-weight: 600; }
    .loop-banner-msg { flex: 1; }
    .loop-banner-actions { display: flex; gap: 4px; }
    .loop-banner-actions button {
      padding: 3px 8px; font-size: 11px;
      background: rgba(255,255,255,0.06); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
      cursor: pointer;
    }

    .loop-summary {
      padding: 8px 10px; margin: 6px 0;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
      background: rgba(255,255,255,0.04); font-size: 12px;
    }
    .lsum-title { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
    .lsum-close { background: none; border: none; color: inherit; cursor: pointer; font-size: 14px; padding: 0; }
    .lsum-line { margin-top: 4px; opacity: 0.85; }
    .lsum-reason { margin-top: 2px; opacity: 0.65; font-size: 11px; }
    .lsum-prompt-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .lsum-prompt-btn {
      padding: 3px 8px; font-size: 11px; font: inherit;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 4px;
      cursor: pointer;
    }
    .lsum-prompt-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .lsum-prompt-block {
      margin-top: 6px;
      padding: 8px 10px;
      background: rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 4px;
      max-height: 320px;
      overflow: auto;
    }
    .lsum-prompt-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.6;
      margin-bottom: 2px;
    }
    .lsum-prompt-label + .lsum-prompt-pre { margin-top: 0; }
    .lsum-prompt-pre {
      margin: 0 0 8px 0;
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      color: inherit;
    }
    .lsum-prompt-pre:last-child { margin-bottom: 0; }
    code { font-size: 11px; padding: 1px 4px; background: rgba(255,255,255,0.08); border-radius: 3px; }
  `],
})
export class LoopControlComponent implements OnDestroy {
  chatId = input<string | null>(null);

  protected store = inject(LoopStore);
  private clipboard = inject(CLIPBOARD_SERVICE);

  /** 1Hz tick that drives elapsed-time recomputation in the active strip. */
  private tick = signal(0);
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  /** Summary card UI state — owned by this component because the card
   *  itself is owned here. */
  protected promptExpanded = signal(false);
  protected copiedSummaryPart = signal<'initial' | 'iteration' | null>(null);
  protected inspectorExpanded = signal(false);
  protected inspectorLoading = signal(false);
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

  // ────── loop control actions ──────

  async onPause(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.pause(a.id);
  }

  async onResumeAnyway(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.resume(a.id);
  }

  async onStop(): Promise<void> {
    const a = this.active(); if (!a) return;
    await this.store.cancel(a.id);
  }

  async onInjectHint(): Promise<void> {
    const a = this.active(); if (!a) return;
    const message = window.prompt('Inject a hint for the next iteration:');
    if (!message?.trim()) return;
    await this.store.intervene(a.id, message.trim());
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
  protected summaryStatusLabel(status: 'completed' | 'cancelled' | 'cap-reached' | 'error' | 'no-progress'): string {
    return terminalStatusLabel(status);
  }
}
