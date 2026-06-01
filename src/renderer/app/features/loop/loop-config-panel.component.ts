import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LoopIpcService, type LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { DEFAULT_LOOP_PROMPT, LoopPromptHistoryService } from './loop-prompt-history.service';

// Defaults that match defaultLoopConfig() in src/shared/types/loop.types.ts.
// We must include all sub-fields whenever caps/completion/progressThresholds
// are sent — Zod's `LoopConfigInputSchema` only makes the top-level keys
// optional, so an empty `progressThresholds: {}` would fail validation.
const DEFAULT_CAPS = {
  maxTokens: 1_000_000,
  maxToolCallsPerIteration: 200,
};
const DEFAULT_COMPLETION = {
  completedFilenamePattern: '*_[Cc]ompleted.md',
  donePromiseRegex: '<promise>\\s*DONE\\s*</promise>',
  doneSentinelFile: 'DONE.txt',
  verifyTimeoutMs: 600_000,
  quickVerifyTimeoutMs: 120_000,
};
/** Mirrors defaultLoopConfig().progressThresholds. We only ever ship this
 *  to the main process when the user opts into a non-default progress toggle,
 *  because Zod requires the full strict
 *  shape if the field is present at all. */
const DEFAULT_PROGRESS_THRESHOLDS = {
  identicalHashWarnConsecutive: 2,
  identicalHashCriticalConsecutive: 3,
  identicalHashCriticalWindow: 3,
  similarityWarnMean: 0.85,
  similarityCriticalMean: 0.92,
  stageWarnIterations: { PLAN: 3, REVIEW: 2, IMPLEMENT: 8 },
  stageCriticalIterations: { PLAN: 5, REVIEW: 3, IMPLEMENT: 12 },
  errorRepeatWarnInWindow: 3,
  errorRepeatCriticalInWindow: 4,
  tokensWithoutProgressWarn: 25_000,
  tokensWithoutProgressCritical: 60_000,
  pauseOnTokenBurn: false,
  toolRepeatWarnPerIteration: 5,
  toolRepeatCriticalPerIteration: 8,
  testStagnationWarnIterations: 3,
  testStagnationCriticalIterations: 5,
  churnRatioWarn: 0.30,
  churnRatioCritical: 0.50,
  warnEscalationWindow: 5,
  warnEscalationCount: 3,
};
const DEFAULT_SEMANTIC_PROGRESS = {
  cadence: 5,
  confidenceFloor: 0.6,
};
const DEFAULT_EXPLORATION = {
  fanout: 3,
  crossModel: false as const,
  selector: 'verify+listwise' as const,
};

/**
 * Inline accordion panel for configuring and starting a loop.
 *
 * Renders directly above the message composer (slides up). Pre-fills the
 * prompt from the textarea content (or the user's last prompt, or the
 * canonical default), and surfaces the last 3 unique prompts as quick-pick
 * chips. Advanced fields (caps, verify, provider, review style) are tucked
 * behind a "Show advanced" expander to keep the visible panel compact.
 */
@Component({
  selector: 'app-loop-config-panel',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './loop-config-panel.component.html',
  styleUrl: './loop-config-panel.component.scss',
})
export class LoopConfigPanelComponent {
  workspaceCwd = input.required<string>();
  /** The composer's current textarea content. Shown as a "will be prepended"
   *  preview so the user knows their message is being combined with the loop
   *  prompt. Doesn't autofill the prompt field — that belongs to the user. */
  firstMessageHint = input<string>('');
  /** External pre-fill for the prompt textarea. Set by the host when the
   *  user clicks "Reattempt" on a past loop run so they don't have to
   *  re-type or paste. A non-null/non-empty value overwrites the recall
   *  fallback. The host bumps this signal each time it wants a fresh seed
   *  applied (e.g. consecutive Reattempts on different runs); we react to
   *  every update rather than only the initial value. */
  seedPrompt = input<string | null>(null);

  dismissed = output<void>();
  /** Emits whenever the panel's submittability changes. Lets the host
   *  enable/disable the Send button without having to viewChild-query us
   *  (signal-based viewChild + @if has timing surprises). */
  validityChange = output<boolean>();
  /** Emits the current built config (or null if invalid) on any change.
   *  Host uses this to pull the latest config when the user hits Send. */
  configChange = output<LoopStartConfigInput | null>();

  private history = inject(LoopPromptHistoryService);
  private loopIpc = inject(LoopIpcService);
  recentPrompts = this.history.recent;
  defaultPrompt = DEFAULT_LOOP_PROMPT;

  /** LF-3a: the verify command the loop would auto-infer for this workspace,
   *  surfaced so the user knows what gates completion before they start. */
  protected inferredVerify = signal<{ command: string; source: string } | null>(null);
  protected inferLoading = signal(false);
  private lastInferredWorkspace: string | null = null;

  prompt = signal('');
  planFile = signal('');
  maxIterations = signal(50);
  maxHours = signal(8);
  // LF-3: default to a $10 spend ceiling (mirrors defaultLoopConfig). Clear the
  // field to null for an unbounded run. Operator-reviewed completion requires a
  // non-null cap (LF-3a) — the validationError below enforces that.
  maxDollars = signal<number | null>(10);
  verifyCommand = signal('');
  quickVerifyCommand = signal('');
  provider = signal<'claude' | 'codex'>('claude');
  reviewStyle = signal<'single' | 'debate' | 'star-chamber'>('debate');
  contextStrategy = signal<'fresh-child' | 'hybrid' | 'same-session'>('same-session');
  initialStage = signal<'PLAN' | 'REVIEW' | 'IMPLEMENT'>('IMPLEMENT');
  /** Per-iteration wall-clock cap, exposed in minutes for UI sanity. */
  iterationTimeoutMin = signal(30);
  /** Per-iteration stream-idle warning, exposed in seconds for UI sanity. */
  streamIdleTimeoutSec = signal(300);
  requireRename = signal(false);
  runVerifyTwice = signal(true);
  /** LF-1: recycle the same-session adapter to a fresh session on long runs. */
  compactContext = signal(true);
  /** LF-4: disposable plan — regenerate from the goal on repeated stall. */
  regenerateOnStall = signal(false);
  semanticProgress = signal(false);
  branchSelect = signal(false);
  branchFanout = signal(DEFAULT_EXPLORATION.fanout);
  /** Reset threshold as a fraction (mirrors defaultLoopContextConfig 0.6). */
  compactionResetUtilization = signal(0.6);
  compactionThresholdPct = computed(() => Math.round(this.compactionResetUtilization() * 100));
  operatorReviewedCompletion = signal(false);
  freshEyesReview = signal(false);
  /** Opt-in for signal F (token-burn-without-test-progress). Default off so
   *  legitimate non-test-driven loops (new module scaffolds, refactors with
   *  no test deltas, doc/asset generation) don't pause spuriously. */
  pauseOnTokenBurn = signal(false);
  allowDestructive = signal(false);
  showAdvanced = signal(false);
  planFileRequiresRename = computed(() => this.planFile().trim().length > 0);
  effectiveRequireRename = computed(() => this.planFileRequiresRename() || this.requireRename());

  constructor() {
    // Scope history to the workspace so directives don't leak across
    // unrelated projects on the same machine.
    effect(() => {
      this.history.setWorkspace(this.workspaceCwd() || null);
    });
    // External seed (from "Reattempt past run") — overwrites the prompt
    // textarea unconditionally on every change. We trust the host to only
    // bump the seed when it really wants the panel to update; the host
    // uses a request-id pattern to avoid stomping on user typing across
    // unrelated re-renders.
    effect(() => {
      const seed = this.seedPrompt();
      if (seed != null && seed.length > 0) {
        this.prompt.set(seed);
      }
    });
    // Pre-fill the prompt: most recent saved > canonical default.
    // Deliberately don't autofill from the message textarea — that's the
    // user's pending message, not the loop's seed prompt.
    effect(() => {
      if (this.prompt().trim()) return;
      const recent = this.recentPrompts();
      if (recent.length > 0) {
        this.prompt.set(recent[0]);
        return;
      }
      this.prompt.set(DEFAULT_LOOP_PROMPT);
    });
    // Push validity + current config up to the host on every change so the
    // host doesn't need a viewChild reference (which has timing issues with
    // @if-rendered components).
    effect(() => {
      this.validityChange.emit(this.canSubmit());
    });
    effect(() => {
      this.configChange.emit(this.canSubmit() ? this.buildConfig() : null);
    });
    // LF-3a: preview the auto-inferred verify command once per workspace so the
    // verify field's hint shows what will gate completion. Keyed on
    // workspaceCwd (stable) so it doesn't re-run on every prompt keystroke.
    effect(() => {
      const cwd = this.workspaceCwd();
      if (!cwd || cwd === this.lastInferredWorkspace) return;
      this.lastInferredWorkspace = cwd;
      untracked(() => { void this.loadInferredVerify(cwd); });
    });
  }

  private async loadInferredVerify(workspaceCwd: string): Promise<void> {
    this.inferLoading.set(true);
    try {
      const response = await this.loopIpc.inferVerify(workspaceCwd);
      this.inferredVerify.set(response.success ? (response.data?.inferred ?? null) : null);
    } catch {
      this.inferredVerify.set(null);
    } finally {
      this.inferLoading.set(false);
    }
  }

  /** Dynamic hint for the verify-command field: shows the auto-detected command
   *  when the field is blank, so the user can see what will gate completion. */
  verifyHint = computed<string>(() => {
    if (this.verifyCommand().trim()) return '(custom command)';
    if (this.inferLoading()) return '(detecting…)';
    const inferred = this.inferredVerify();
    if (inferred) return `(auto-detected: ${inferred.command})`;
    return '(no verifier detected — set one or enable operator review)';
  });

  validationError = computed(() => {
    if (!this.prompt().trim()) return 'Prompt is required.';
    if (this.maxIterations() < 1) return 'Max iterations must be at least 1.';
    if (this.maxHours() < 1) return 'Max wall time must be at least 1 hour.';
    const maxDollars = this.maxDollars();
    if (maxDollars !== null && maxDollars < 1) return 'Max spend must be at least $1, or blank for no cap.';
    if (this.compactContext()) {
      const pct = this.compactionThresholdPct();
      if (!Number.isFinite(pct) || pct < 10 || pct > 95) {
        return 'Context recycle threshold must be between 10% and 95%.';
      }
    }
    if (this.branchSelect()) {
      if (maxDollars === null) return 'Branch-select on stuck requires a spend cap ($). Set Max spend.';
      const fanout = this.branchFanout();
      if (!Number.isFinite(fanout) || fanout < 2 || fanout > 8) {
        return 'Branch fanout must be between 2 and 8.';
      }
    }
    // LF-3a: operator-reviewed loops pause for manual sign-off and get resumed
    // repeatedly — require a spend cap so an unbounded run can't sit and burn.
    if (this.operatorReviewedCompletion() && maxDollars === null) {
      return 'Operator-reviewed completion requires a spend cap ($). Set Max spend, or add a verify command.';
    }
    return null;
  });

  canSubmit = computed(() => !this.validationError());

  toggleEvent(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
  }

  onForgetPrompt(entry: string): void {
    this.history.forget(entry);
    if (this.prompt() === entry) this.prompt.set('');
  }

  onCompactionThresholdPctChange(value: number | string | null): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    this.compactionResetUtilization.set(numeric / 100);
  }

  onBranchFanoutChange(value: number | string | null): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    this.branchFanout.set(numeric);
  }

  /**
   * Build the current config payload, or return null if validation fails.
   * Called by the host (input-panel) when the user hits Send while the
   * panel is open — the panel itself no longer has a Start Loop button.
   */
  buildConfig(): LoopStartConfigInput | null {
    if (!this.canSubmit()) return null;
    const planFile = this.planFile().trim() || undefined;
    const maxDollars = this.maxDollars();
    const quickVerifyCommand = this.quickVerifyCommand().trim();
    return {
      initialPrompt: this.prompt().trim(),
      workspaceCwd: this.workspaceCwd(),
      planFile,
      provider: this.provider(),
      reviewStyle: this.reviewStyle(),
      contextStrategy: this.contextStrategy(),
      initialStage: this.initialStage(),
      caps: {
        maxIterations: this.maxIterations(),
        maxWallTimeMs: this.maxHours() * 60 * 60 * 1000,
        maxTokens: DEFAULT_CAPS.maxTokens,
        maxCostCents: maxDollars === null ? null : maxDollars * 100,
        maxToolCallsPerIteration: DEFAULT_CAPS.maxToolCallsPerIteration,
      },
      completion: {
        completedFilenamePattern: DEFAULT_COMPLETION.completedFilenamePattern,
        donePromiseRegex: DEFAULT_COMPLETION.donePromiseRegex,
        doneSentinelFile: DEFAULT_COMPLETION.doneSentinelFile,
        verifyCommand: this.verifyCommand().trim(),
        allowOperatorReviewedCompletion: this.operatorReviewedCompletion(),
        verifyTimeoutMs: DEFAULT_COMPLETION.verifyTimeoutMs,
        ...(quickVerifyCommand
          ? {
              quickVerifyCommand,
              quickVerifyTimeoutMs: DEFAULT_COMPLETION.quickVerifyTimeoutMs,
            }
          : {}),
        runVerifyTwice: this.runVerifyTwice(),
        requireCompletedFileRename: this.effectiveRequireRename(),
        ...(this.freshEyesReview()
          ? {
              crossModelReview: {
                enabled: true,
                blockingSeverities: ['critical', 'high'],
                timeoutSeconds: 90,
                reviewDepth: 'structured',
              },
            }
          : {}),
      },
      // Only override progressThresholds when the user has opted into a
      // non-default behaviour. Otherwise omit it entirely so the main
      // process applies its own canonical defaults — keeps the IPC payload
      // small and leaves the source of truth in one place.
      ...(this.pauseOnTokenBurn()
        ? {
            progressThresholds: {
              ...DEFAULT_PROGRESS_THRESHOLDS,
              pauseOnTokenBurn: true,
            },
          }
        : {}),
      allowDestructiveOps: this.allowDestructive(),
      context: {
        compaction: {
          enabled: this.compactContext(),
          resetAtUtilization: this.compactionResetUtilization(),
          clearToolResults: true,
        },
      },
      ...(this.semanticProgress()
        ? {
            semanticProgress: {
              enabled: true,
              cadence: DEFAULT_SEMANTIC_PROGRESS.cadence,
              confidenceFloor: DEFAULT_SEMANTIC_PROGRESS.confidenceFloor,
            },
          }
        : {}),
      ...(this.branchSelect()
        ? {
            exploration: {
              enabled: true,
              fanout: this.branchFanout(),
              crossModel: DEFAULT_EXPLORATION.crossModel,
              selector: DEFAULT_EXPLORATION.selector,
            },
          }
        : {}),
      plan: { regenerateOnStall: this.regenerateOnStall() },
      iterationTimeoutMs: this.iterationTimeoutMin() * 60 * 1000,
      streamIdleTimeoutMs: this.streamIdleTimeoutSec() * 1000,
    };
  }
}
