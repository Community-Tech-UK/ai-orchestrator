import { ChangeDetectionStrategy, Component, Input, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LoopIpcService, type LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import { DEFAULT_LOOP_PROMPT, LoopPromptHistoryService } from './loop-prompt-history.service';
import {
  DEFAULT_INSTANCE_PROVIDERS,
  PROVIDER_MENU_LABELS,
} from '../models/provider-menu.constants';
import type { PickerProvider } from '../models/compact-model-picker.types';
import {
  REMOTE_REVIEWER_PROVIDER_DEFINITIONS,
  type RemoteReviewerProvider,
} from '../../../../shared/types/reviewer-provider.types';
import { resolveLoopGoalIntent } from '../../../../shared/utils/loop-intent';

// Defaults that match defaultLoopConfig() in src/shared/types/loop.types.ts.
// We must include all sub-fields whenever caps/completion/progressThresholds
// are sent — those strict blocks fail validation if they are present but empty.
const DEFAULT_CAPS = {
  maxIterations: 50,
  maxToolCallsPerIteration: 200,
};
/** WS6: finite new-loop defaults (mirrors DEFAULT_LOOP_MAX_COST_CENTS = 3000
 *  and LOOP_DEFAULT_MAX_TURNS_PER_ITERATION = 30 in shared loop types). */
const DEFAULT_MAX_DOLLARS = 30;
const DEFAULT_MAX_TURNS_PER_ITERATION = 30;
/** Lower bound for the optional token cap. Below this a single substantial
 *  iteration (file reads + a long turn) would trip it instantly, which is the
 *  exact foot-gun the old hidden 1M default caused on 1M-context models. */
const MIN_MAX_TOKENS = 10_000;
const MAX_MAX_TOKENS = 100_000_000;
const DEFAULT_MAX_WALL_TIME_HOURS = 50;
const MAX_WALL_TIME_HOURS = 7 * 24;
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
  identicalToolCallConsecutiveCritical: 3,
  idempotentReadRepeatWarn: 3,
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
const DEFAULT_NEXT_OBJECTIVE_PLANNING = {
  cadence: 1,
};
const DEFAULT_AUDIT = {
  finalAuditMode: 'gate' as const,
  preflightMode: 'record' as const,
  planPacketMode: 'prompted' as const,
  cleanlinessScan: true,
};
type PlanPacketMode = 'off' | 'prompted';

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
  private defaultProviderSignal = signal<PickerProvider>('claude');
  private availableProvidersSignal = signal<PickerProvider[]>(DEFAULT_INSTANCE_PROVIDERS);

  /** Concrete chat/session provider to use unless the user overrides it. */
  @Input() set defaultProvider(value: PickerProvider | null | undefined) {
    this.defaultProviderSignal.set(this.resolveProvider(value, DEFAULT_INSTANCE_PROVIDERS));
  }

  /** Providers available on the chat/session picker. `auto` is resolved before loop start. */
  @Input() set availableProviders(value: PickerProvider[] | null | undefined) {
    this.availableProvidersSignal.set(value && value.length > 0 ? value : DEFAULT_INSTANCE_PROVIDERS);
  }

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
  maxIterations = signal<number | null>(DEFAULT_CAPS.maxIterations);
  maxHours = signal(DEFAULT_MAX_WALL_TIME_HOURS);
  /** WS6: new loops default to a finite $30 estimated cost cap. `null`
   *  (unbounded) requires the deliberate `allowUnbounded` toggle below. */
  maxDollars = signal<number | null>(DEFAULT_MAX_DOLLARS);
  /** WS6: deliberate "Allow unbounded estimated spend" choice. Only while
   *  enabled may the cost cap be blank (emitting explicit `null`). */
  allowUnbounded = signal(false);
  /** WS6: per-iteration turn cap — the primary bound WITHIN an iteration
   *  (the cost check runs between iterations). */
  maxTurns = signal<number | null>(DEFAULT_MAX_TURNS_PER_ITERATION);
  /** Fable WS6: selected recipe pack for the per-stage work prompts. */
  loopRecipe = signal('coding');
  /** WS7 Phase A: opt-in provider failover for this run. */
  failoverEnabled = signal(false);
  failoverProviders = signal<string[]>([]);
  recipeOptions = signal<{ name: string; description: string; source: 'built-in' | 'user' }[]>([
    { name: 'coding', description: 'Default software-implementation stages.', source: 'built-in' },
  ]);
  /** Total token budget across the whole loop. Null = no cap (the default),
   *  so iterations/hours/spend govern. Previously hard-coded to 1M and hidden
   *  from the UI, which silently killed 1M-context runs after one iteration. */
  maxTokens = signal<number | null>(null);
  verifyCommand = signal('');
  quickVerifyCommand = signal('');
  provider = signal<PickerProvider>('claude');
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
  nextObjectivePlanning = signal(false);
  nextObjectiveCadence = signal(DEFAULT_NEXT_OBJECTIVE_PLANNING.cadence);
  finalAuditMode = signal<'off' | 'observe' | 'gate'>(DEFAULT_AUDIT.finalAuditMode);
  preflightMode = signal<'off' | 'record' | 'block'>(DEFAULT_AUDIT.preflightMode);
  planPacketMode = signal<PlanPacketMode>(DEFAULT_AUDIT.planPacketMode);
  cleanlinessScan = signal(DEFAULT_AUDIT.cleanlinessScan);
  /** Reset threshold as a fraction (mirrors defaultLoopContextConfig 0.6). */
  compactionResetUtilization = signal(0.6);
  compactionThresholdPct = computed(() => Math.round(this.compactionResetUtilization() * 100));
  operatorReviewedCompletion = signal(false);
  freshEyesReview = signal(false);
  /** Ping-pong mode: a different-provider agentic reviewer reviews every
   *  builder done-declaration until both models agree (or a backstop fires). */
  pingPongEnabled = signal(true);
  pingPongReviewerProvider = signal<'auto' | RemoteReviewerProvider>('auto');
  readonly pingPongReviewerOptions = REMOTE_REVIEWER_PROVIDER_DEFINITIONS;
  pingPongSubject = signal<'auto' | 'plan' | 'impl'>('auto');
  pingPongMaxRounds = signal(15);
  providerOptions = computed<PickerProvider[]>(() => {
    const providers = this.availableProvidersSignal().filter((provider) => provider !== 'local-model');
    return providers.length > 0
      ? providers
      : DEFAULT_INSTANCE_PROVIDERS.filter((provider) => provider !== 'local-model');
  });
  private providerManuallyOverridden = false;
  /**
   * Completion strategy. 'review-driven' (default) keeps re-reviewing with
   * fresh eyes and fixing what it finds until N consecutive clean passes;
   * 'gated' is the legacy verify / declared-done evidence ladder.
   */
  completionMode = signal<'review-driven' | 'gated'>('review-driven');
  /** review-driven: consecutive clean fresh-eyes passes required to finish. */
  requiredCleanPasses = signal(2);
  /** Opt-in for signal F (token-burn-without-test-progress). Default off so
   *  legitimate non-test-driven loops (new module scaffolds, refactors with
   *  no test deltas, doc/asset generation) don't pause spuriously. */
  pauseOnTokenBurn = signal(false);
  allowDestructive = signal(false);
  showAdvanced = signal(false);
  private planPacketModeManuallyOverridden = false;
  planFileRequiresRename = computed(() => this.planFile().trim().length > 0);
  effectiveRequireRename = computed(() => this.planFileRequiresRename() || this.requireRename());
  private defaultPlanPacketMode = computed<PlanPacketMode>(() => {
    if (this.planFile().trim()) return 'prompted';
    if (this.prompt().length >= 800) return 'prompted';
    const maxIterations = this.maxIterations();
    if (maxIterations === null) return 'prompted';
    return maxIterations >= 5 ? 'prompted' : 'off';
  });

  constructor() {
    // Fable WS6: populate the recipe picker (falls back to the static
    // `coding` entry outside Electron or on failure).
    void this.loadRecipeOptions();
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
    // Default the loop provider from the chat/session provider. Once the user
    // changes the advanced provider selector, keep that override unless the
    // selected provider disappears from the available list.
    effect(() => {
      const providers = this.providerOptions();
      const fallback = this.resolveProvider(this.defaultProviderSignal(), providers);
      const current = this.provider();
      if (!providers.includes(current) || !this.providerManuallyOverridden) {
        untracked(() => this.provider.set(fallback));
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
    // Match prepareLoopStartConfig's dynamic plan-packet default. If the user
    // explicitly changes the Advanced select, preserve that choice.
    effect(() => {
      const mode = this.defaultPlanPacketMode();
      if (this.planPacketModeManuallyOverridden) return;
      untracked(() => this.planPacketMode.set(mode));
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
    const maxIterations = this.maxIterations();
    if (maxIterations !== null && maxIterations < 1) return 'Max iterations must be at least 1, or blank for no cap.';
    if (this.maxHours() < 1) return 'Max wall time must be at least 1 hour.';
    if (this.maxHours() > MAX_WALL_TIME_HOURS) return 'Max wall time must be 168 hours or less.';
    const maxDollars = this.maxDollars();
    if (maxDollars !== null && maxDollars < 1) return 'Estimated usage cap must be at least $1.';
    // WS6: blank spend is a deliberate choice, not a default.
    if (maxDollars === null && !this.allowUnbounded()) {
      return 'Estimated usage cap is blank — set a cap, or enable "Allow unbounded estimated spend".';
    }
    const maxTurns = this.maxTurns();
    if (maxTurns !== null && (!Number.isFinite(maxTurns) || maxTurns < 1 || maxTurns > 500)) {
      return 'Max turns per iteration must be between 1 and 500, or blank for the provider default.';
    }
    const maxTokens = this.maxTokens();
    if (maxTokens !== null && (!Number.isFinite(maxTokens) || maxTokens < MIN_MAX_TOKENS)) {
      return 'Max tokens must be at least 10,000, or blank for no cap.';
    }
    if (maxTokens !== null && maxTokens > MAX_MAX_TOKENS) {
      return 'Max tokens must be 100,000,000 or less.';
    }
    if (this.compactContext()) {
      const pct = this.compactionThresholdPct();
      if (!Number.isFinite(pct) || pct < 10 || pct > 95) {
        return 'Context recycle threshold must be between 10% and 95%.';
      }
    }
    if (this.branchSelect()) {
      if (maxDollars === null) return 'Branch-select on stuck requires an estimated usage cap ($). Set Estimated usage cap.';
      const fanout = this.branchFanout();
      if (!Number.isFinite(fanout) || fanout < 2 || fanout > 8) {
        return 'Branch fanout must be between 2 and 8.';
      }
    }
    if (this.nextObjectivePlanning()) {
      const cadence = this.nextObjectiveCadence();
      if (!Number.isFinite(cadence) || cadence < 1 || cadence > 50) {
        return 'Next-objective cadence must be between 1 and 50.';
      }
    }
    // LF-3a: operator-reviewed loops pause for manual sign-off and get resumed
    // repeatedly — require a usage cap so an unbounded run can't sit and burn.
    if (this.operatorReviewedCompletion() && maxDollars === null) {
      return 'Operator-reviewed completion requires an estimated usage cap ($). Set Estimated usage cap, or add a verify command.';
    }
    // WS6 verification authority (same rule enforced in the main process):
    // an implementation goal cannot imply autonomous completion without a
    // verify command or explicit operator-reviewed authority.
    if (
      resolveLoopGoalIntent(undefined, this.prompt()).intent === 'implementation'
      && !this.verifyCommand().trim()
      && !this.operatorReviewedCompletion()
    ) {
      return 'Implementation goals need a verification authority: add a verify command '
        + '(tests/build/typecheck), or enable operator-reviewed completion.';
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

  onMaxIterationsChange(value: number | string | null): void {
    if (value === null || value === '') {
      this.maxIterations.set(null);
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    this.maxIterations.set(numeric);
  }

  onMaxDollarsChange(value: number | string | null): void {
    if (value === null || value === '') {
      this.maxDollars.set(null);
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    this.maxDollars.set(numeric);
  }

  onMaxTurnsChange(value: number | string | null): void {
    if (value === null || value === '') {
      this.maxTurns.set(null);
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    this.maxTurns.set(numeric);
  }

  onMaxTokensChange(value: number | string | null): void {
    if (value === null || value === '') {
      this.maxTokens.set(null);
      return;
    }
    const numeric = typeof value === 'number' ? value : Number(value);
    this.maxTokens.set(numeric);
  }

  onBranchFanoutChange(value: number | string | null): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    this.branchFanout.set(numeric);
  }

  onNextObjectiveCadenceChange(value: number | string | null): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    this.nextObjectiveCadence.set(numeric);
  }

  onPlanPacketModeChange(value: PlanPacketMode): void {
    this.planPacketModeManuallyOverridden = true;
    this.planPacketMode.set(value);
  }

  onProviderChange(value: string): void {
    const provider = this.resolveProvider(value, this.providerOptions());
    this.providerManuallyOverridden = true;
    this.provider.set(provider);
  }

  providerLabel(provider: PickerProvider): string {
    return PROVIDER_MENU_LABELS[provider];
  }

  private resolveProvider(value: string | null | undefined, providers: PickerProvider[]): PickerProvider {
    const provider = value === 'claude' || value === 'codex' || value === 'gemini' || value === 'antigravity' || value === 'copilot' || value === 'cursor' || value === 'grok'
      ? value
      : 'claude';
    return providers.includes(provider) ? provider : (providers[0] ?? 'claude');
  }

  /**
   * Build the current config payload, or return null if validation fails.
   * Called by the host (input-panel) when the user hits Send while the
   * panel is open — the panel itself no longer has a Start Loop button.
   */
  /** Fable WS6: populate the recipe picker from the main-process registry. */
  async loadRecipeOptions(): Promise<void> {
    const res = await this.loopIpc.listRecipes();
    if (res.success && res.data?.recipes?.length) {
      this.recipeOptions.set(res.data.recipes.map((r) => ({
        name: r.name, description: r.description, source: r.source,
      })));
      if (!res.data.recipes.some((r) => r.name === this.loopRecipe())) {
        this.loopRecipe.set('coding');
      }
    }
  }

  toggleFailoverProvider(provider: string, checked: boolean): void {
    const current = new Set(this.failoverProviders());
    if (checked) current.add(provider); else current.delete(provider);
    this.failoverProviders.set([...current]);
  }

  buildConfig(): LoopStartConfigInput | null {
    if (!this.canSubmit()) return null;
    const provider = this.provider();
    if (provider === 'local-model') return null;
    const planFile = this.planFile().trim() || undefined;
    const maxDollars = this.maxDollars();
    const quickVerifyCommand = this.quickVerifyCommand().trim();
    return {
      initialPrompt: this.prompt().trim(),
      workspaceCwd: this.workspaceCwd(),
      planFile,
      provider,
      reviewStyle: this.reviewStyle(),
      contextStrategy: this.contextStrategy(),
      initialStage: this.initialStage(),
      maxTurnsPerIteration: this.maxTurns(),
      loopRecipe: this.loopRecipe(),
      ...(this.failoverEnabled() && this.failoverProviders().length > 0
        ? {
            failover: {
              enabled: true,
              providers: this.failoverProviders() as ('claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok')[],
              maxSwitches: 1,
            },
          }
        : {}),
      caps: {
        maxIterations: this.maxIterations(),
        maxWallTimeMs: this.maxHours() * 60 * 60 * 1000,
        maxTokens: this.maxTokens(),
        maxCostCents: maxDollars === null ? null : maxDollars * 100,
        maxToolCallsPerIteration: DEFAULT_CAPS.maxToolCallsPerIteration,
      },
      completion: {
        // Ping-pong runs ON TOP of review-driven mode (dedicated completion
        // branch), so arming it forces review-driven regardless of the picker.
        mode: this.pingPongEnabled() ? 'review-driven' : this.completionMode(),
        requiredCleanReviewPasses: this.requiredCleanPasses(),
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
        ...(this.pingPongEnabled()
          ? {
              crossModelReview: {
                enabled: true,
                blockingSeverities: ['critical', 'high'] as ('critical' | 'high' | 'medium' | 'low')[],
                timeoutSeconds: 90,
                reviewDepth: 'structured' as const,
                pingPong: {
                  enabled: true,
                  reviewerProvider: this.pingPongReviewerProvider(),
                  subject: this.pingPongSubject(),
                  maxRounds: this.pingPongMaxRounds(),
                },
              },
            }
          : this.freshEyesReview()
          ? {
              crossModelReview: {
                enabled: true,
                blockingSeverities: ['critical', 'high'] as ('critical' | 'high' | 'medium' | 'low')[],
                timeoutSeconds: 90,
                reviewDepth: 'structured' as const,
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
      ...(this.nextObjectivePlanning()
        ? {
            nextObjectivePlanning: {
              enabled: true,
              cadence: this.nextObjectiveCadence(),
            },
          }
        : {}),
      plan: { regenerateOnStall: this.regenerateOnStall() },
      audit: {
        finalAuditMode: this.finalAuditMode(),
        preflightMode: this.preflightMode(),
        planPacketMode: this.planPacketMode(),
        cleanlinessScan: this.cleanlinessScan(),
      },
      iterationTimeoutMs: this.iterationTimeoutMin() * 60 * 1000,
      streamIdleTimeoutMs: this.streamIdleTimeoutSec() * 1000,
    };
  }
}
