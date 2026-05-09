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
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { LoopStore } from '../../core/state/loop.store';
import {
  formatCostCents,
  formatTimestamp,
  humanTokens,
  loopStatusLabel,
  relativeTime,
} from './loop-formatters.util';
import { LoopPanelOpenerService } from './loop-panel-opener.service';

/** Subset of `LoopRunSummaryPayload` that the reattempt-mapping logic
 *  depends on. Narrowed so the helper can be unit-tested with minimal
 *  fixtures and so the contract is explicit. */
export interface ReattemptSourceRun {
  initialPrompt: string;
  iterationPrompt: string | null;
}

/** Pure derivation of `seedMessage` (textarea / iter-0 goal) and
 *  `seedPrompt` (panel / iter-1+ continuation) from a past loop run.
 *
 * Two cases:
 * - The past run had a distinct iter-1+ continuation (`iterationPrompt`
 *   different from `initialPrompt` and non-empty). Reattempt seeds the
 *   textarea with the goal and the panel with the continuation, so the
 *   user sends them as iter 0 + iter 1+ exactly like the original run.
 * - The past run reused `initialPrompt` for every iteration. Reattempt
 *   seeds *only* the panel and leaves the textarea empty, so the
 *   input-panel's "textarea-empty → reuse panel prompt for iter 0 too"
 *   fallback recreates the original single-prompt behaviour.
 *
 * Returns `null` when the run has no recorded prompt (corrupt row or
 * legacy format) — the caller should disable the Reattempt action in
 * that case rather than seeding empty values.
 */
export function deriveReattemptSeed(
  run: ReattemptSourceRun,
): { seedMessage: string; seedPrompt: string } | null {
  if (!run.initialPrompt) return null;

  const distinctContinuation =
    typeof run.iterationPrompt === 'string'
    && run.iterationPrompt.length > 0
    && run.iterationPrompt !== run.initialPrompt
      ? run.iterationPrompt
      : null;

  return {
    seedMessage: distinctContinuation !== null ? run.initialPrompt : '',
    seedPrompt: distinctContinuation ?? run.initialPrompt,
  };
}

/**
 * "Past loop prompts" panel — collapsible list of persisted loop runs
 * for the current chat, with per-row Show / Copy / Reattempt actions.
 *
 * Lifted out of `LoopControlComponent` so:
 *  - the surrounding component stays focused on banner/active/summary,
 *  - the panel's UI state (expanded rows, copy flashes) is reset by
 *    component creation/destruction rather than by ad-hoc `lastChatId`
 *    bookkeeping in the parent,
 *  - the panel can be reused or repositioned independently.
 *
 * The component owns its own auto-refresh wiring: it pulls history when
 * mounted (and on chatId change) and again whenever the chat's terminal
 * summary changes — that keeps the list fresh without the parent having
 * to remember to call `refreshHistory()` itself.
 */
@Component({
  selector: 'app-loop-past-runs-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (runs().length > 0) {
      <div class="past-runs">
        <button
          type="button"
          class="past-runs-toggle"
          (click)="panelExpanded.set(!panelExpanded())"
          [attr.aria-expanded]="panelExpanded()"
        >
          <span class="pr-toggle-caret">{{ panelExpanded() ? '▾' : '▸' }}</span>
          Past loop prompts
          <span class="pr-toggle-count">({{ runs().length }})</span>
        </button>
        @if (panelExpanded()) {
          <div class="past-runs-list" role="list">
            @for (run of runs(); track run.id) {
              <div class="pr-row" role="listitem">
                <div class="pr-row-head">
                  <span class="pr-status" [attr.data-status]="run.status">{{ statusLabel(run.status) }}</span>
                  <span class="pr-time" [title]="absoluteTime(run.startedAt)">{{ relTime(run.startedAt) }}</span>
                  <span class="pr-meta">{{ run.totalIterations }} iter · {{ tokens(run.totalTokens) }} · {{ cost(run.totalCostCents) }}</span>
                  <span class="pr-actions">
                    <button
                      type="button"
                      class="pr-action-btn"
                      (click)="toggleRowExpanded(run.id)"
                      [attr.aria-expanded]="isRowExpanded(run.id)"
                      [title]="isRowExpanded(run.id) ? 'Hide full prompt' : 'Show full prompt'"
                    >{{ isRowExpanded(run.id) ? 'Hide' : 'Show' }}</button>
                    <button
                      type="button"
                      class="pr-action-btn"
                      (click)="onCopy(run)"
                      [disabled]="!run.initialPrompt"
                      [title]="copiedRunId() === run.id ? 'Copied!' : 'Copy this prompt'"
                    >{{ copiedRunId() === run.id ? 'Copied ✓' : 'Copy' }}</button>
                    <button
                      type="button"
                      class="pr-action-btn pr-action-rerun"
                      (click)="onReattempt(run)"
                      [disabled]="reattemptDisabledReason(run) !== null"
                      [title]="reattemptDisabledReason(run) ?? 'Open the loop config pre-filled with this prompt'"
                    >Reattempt</button>
                  </span>
                </div>
                @if (run.initialPrompt) {
                  <div class="pr-prompt-preview" [class.expanded]="isRowExpanded(run.id)">{{ run.initialPrompt }}</div>
                  @if (isRowExpanded(run.id) && hasDistinctIterationPrompt(run)) {
                    <div class="pr-prompt-label">Iteration 1+ continuation</div>
                    <div class="pr-prompt-preview expanded">{{ run.iterationPrompt }}</div>
                  }
                } @else {
                  <div class="pr-prompt-empty">(prompt unavailable for this run)</div>
                }
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .past-runs {
      margin: 6px 0;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      background: rgba(255,255,255,0.025);
      font-size: 12px;
    }
    .past-runs-toggle {
      display: flex; align-items: center; gap: 6px;
      width: 100%;
      padding: 6px 10px;
      background: none; border: none; color: inherit;
      font: inherit; font-weight: 600;
      text-align: left; cursor: pointer;
    }
    .pr-toggle-caret { font-size: 10px; opacity: 0.6; width: 10px; }
    .pr-toggle-count { opacity: 0.55; font-weight: 400; }
    .past-runs-list {
      display: flex; flex-direction: column; gap: 6px;
      padding: 0 10px 8px;
    }
    .pr-row {
      padding: 6px 8px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 4px;
      background: rgba(0,0,0,0.18);
    }
    .pr-row-head {
      display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
      font-size: 11px;
    }
    .pr-status {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 1px 6px; border-radius: 3px;
      background: rgba(255,255,255,0.08);
    }
    .pr-status[data-status="completed"]   { color: #8edc8e; background: rgba(142,220,142,0.12); }
    .pr-status[data-status="cancelled"]   { color: #c8b482; background: rgba(200,180,130,0.12); }
    .pr-status[data-status="cap-reached"] { color: #f7c07a; background: rgba(247,192,122,0.12); }
    .pr-status[data-status="error"]       { color: #f78c7c; background: rgba(247,140,124,0.12); }
    .pr-status[data-status="no-progress"] { color: #f7c07a; background: rgba(247,192,122,0.12); }
    .pr-time { opacity: 0.65; font-family: var(--font-mono, monospace); font-size: 10px; }
    .pr-meta { opacity: 0.6; font-size: 10px; flex: 1; }
    .pr-actions { display: flex; gap: 4px; }
    .pr-action-btn {
      padding: 2px 8px; font-size: 11px; font: inherit;
      background: rgba(255,255,255,0.05); color: inherit;
      border: 1px solid rgba(255,255,255,0.12); border-radius: 3px;
      cursor: pointer;
    }
    .pr-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .pr-action-rerun {
      border-color: rgba(212, 180, 90, 0.5);
      color: var(--primary-color, #d4b45a);
    }
    .pr-action-rerun:hover:not(:disabled) {
      background: rgba(212, 180, 90, 0.12);
    }
    .pr-prompt-preview {
      margin-top: 4px;
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 11px;
      line-height: 1.45;
      color: inherit; opacity: 0.85;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-height: 1.45em;
    }
    .pr-prompt-preview.expanded {
      white-space: pre-wrap;
      word-break: break-word;
      opacity: 1;
      max-height: 240px;
      overflow: auto;
      padding: 6px 8px;
      background: rgba(0,0,0,0.3);
      border-radius: 3px;
    }
    .pr-prompt-label {
      margin-top: 6px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.55;
    }
    .pr-prompt-empty {
      margin-top: 4px; font-size: 11px; opacity: 0.5; font-style: italic;
    }
  `],
})
export class LoopPastRunsPanelComponent implements OnDestroy {
  /** The chat the panel is showing past runs for. Null while no chat is
   *  selected — yields an empty list without errors. */
  chatId = input<string | null>(null);
  /** Set by the parent when a loop is currently active for this chat,
   *  to disable the Reattempt action while one is in flight. */
  loopRunning = input<boolean>(false);
  /** When non-null, signals the parent has just observed a new terminal
   *  summary; we use this to trigger a fresh history pull so the new
   *  row appears at the top without the user reloading. */
  terminalSummaryRunId = input<string | null>(null);
  /** Test seam — when set, used in place of `Date.now()` for relative
   *  time rendering. Production callers leave it at 0 (signal default)
   *  and the component re-evaluates on its 1Hz tick. */
  nowOverride = input<number>(0);

  private store = inject(LoopStore);
  private clipboard = inject(CLIPBOARD_SERVICE);
  private opener = inject(LoopPanelOpenerService);

  /** 1Hz tick to re-render relative timestamps without per-row timers. */
  private tick = signal(0);
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  protected panelExpanded = signal(false);
  protected expandedRowIds = signal<ReadonlySet<string>>(new Set());
  protected copiedRunId = signal<string | null>(null);
  private copiedClearHandle: ReturnType<typeof setTimeout> | null = null;

  /** All persisted runs for the current chat (most recent first). */
  runs = computed<LoopRunSummaryPayload[]>(() => {
    const id = this.chatId();
    if (!id) return [];
    return this.store.runsForChat(id)();
  });

  constructor() {
    this.store.ensureWired();
    this.tickHandle = setInterval(() => this.tick.update((t) => t + 1), 1000);

    // Refresh history whenever the chat changes — also resets the
    // per-chat UI state (expanded rows, copy flash) so a different
    // chat doesn't inherit them.
    effect(() => {
      const id = this.chatId();
      if (!id) return;
      untracked(() => {
        this.expandedRowIds.set(new Set());
        this.copiedRunId.set(null);
        if (this.copiedClearHandle) {
          clearTimeout(this.copiedClearHandle);
          this.copiedClearHandle = null;
        }
        void this.store.refreshHistory(id);
      });
    });

    // Refresh again whenever the parent observed a new terminal summary
    // for this chat. The id is monotonically increasing per-run so equal
    // values mean "we already pulled for this run" — skip in that case.
    effect(() => {
      const id = this.chatId();
      const summaryRunId = this.terminalSummaryRunId();
      if (!id || !summaryRunId) return;
      untracked(() => {
        void this.store.refreshHistory(id);
      });
    });
  }

  ngOnDestroy(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    if (this.copiedClearHandle) clearTimeout(this.copiedClearHandle);
  }

  // ────── per-row UI state ──────

  isRowExpanded(runId: string): boolean {
    return this.expandedRowIds().has(runId);
  }

  toggleRowExpanded(runId: string): void {
    const next = new Set(this.expandedRowIds());
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    this.expandedRowIds.set(next);
  }

  // ────── actions ──────

  async onCopy(run: LoopRunSummaryPayload): Promise<void> {
    if (!run.initialPrompt) return;
    const result = await this.clipboard.copyText(run.initialPrompt, {
      label: 'past loop prompt',
    });
    if (!result.ok) return;
    this.copiedRunId.set(run.id);
    if (this.copiedClearHandle) clearTimeout(this.copiedClearHandle);
    this.copiedClearHandle = setTimeout(() => {
      this.copiedRunId.set(null);
      this.copiedClearHandle = null;
    }, 1800);
  }

  /**
   * Open the loop config panel pre-filled with this past run's prompts.
   * Delegates the iter-0 / iter-1+ mapping to {@link deriveReattemptSeed}
   * so the rules are unit-testable in isolation.
   */
  onReattempt(run: LoopRunSummaryPayload): void {
    if (this.reattemptDisabledReason(run) !== null) return;
    const id = this.chatId();
    if (!id) return;
    const seed = deriveReattemptSeed(run);
    if (!seed) return;
    this.opener.open(id, { ...seed, source: 'reattempt-past-run' });
  }

  /** Returns the reason Reattempt is disabled, or null when the action
   *  can fire. Used both for the `[disabled]` binding and the tooltip
   *  so the user always knows *why* the button is grey. */
  reattemptDisabledReason(run: LoopRunSummaryPayload): string | null {
    if (!run.initialPrompt) return 'No prompt recorded for this run';
    if (this.loopRunning()) return 'A loop is already running for this chat — stop it first';
    if (!this.chatId()) return 'No chat selected';
    return null;
  }

  /** Helper used in the template — keeps the conditional logic for
   *  showing the iteration-1+ block in one place. */
  hasDistinctIterationPrompt(run: LoopRunSummaryPayload): boolean {
    return (
      typeof run.iterationPrompt === 'string'
      && run.iterationPrompt.length > 0
      && run.iterationPrompt !== run.initialPrompt
    );
  }

  // ────── presentational helpers (delegate to pure utils) ──────
  // Methods (rather than direct util references) so the template can
  // bind cleanly without `import {…} from '…'` in the @Component decorator.

  protected statusLabel(status: string): string {
    return loopStatusLabel(status);
  }

  protected tokens(n: number): string {
    return humanTokens(n);
  }

  protected cost(cents: number): string {
    return formatCostCents(cents);
  }

  protected relTime(ts: number): string {
    this.tick(); // re-render at 1Hz
    const override = this.nowOverride();
    return relativeTime(ts, override > 0 ? override : Date.now());
  }

  protected absoluteTime(ts: number): string {
    return formatTimestamp(ts);
  }
}
