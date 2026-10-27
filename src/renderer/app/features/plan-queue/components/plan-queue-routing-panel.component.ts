import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, Injector, OnInit, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DEFAULT_PLAN_QUEUE_ACCOUNT_RULES, DEFAULT_PLAN_QUEUE_ROUTING, type PlanQueueRouteChoice, type PlanQueueRouting, type PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { sameFamily } from '../../../../../shared/models/model-family';
import { sameProviderCheckerCanDiffer } from '../../../../../shared/models/multi-maker-providers';
import { AUTOMATION_PROVIDER_DEFINITIONS } from '../../../../../shared/types/automation-provider.types';
import { isLogicalMiMoModel, isPooledProvider } from '../../../../../shared/types/provider-account.types';
import { getModelsForProvider } from '../../../../../shared/types/provider.types';
import { REMOTE_REVIEWER_PROVIDER_DEFINITIONS } from '../../../../../shared/types/reviewer-provider.types';
import { upgradePlanQueueRouting } from '../../../../../shared/utils/plan-queue-routing-upgrade';
import { CopilotAccountIpcService, type CopilotAccountView } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService, type ProviderAccountView } from '../../../core/services/ipc/provider-account-ipc.service';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { UnifiedCatalogStore } from '../../models/unified-catalog.store';

/** Most worker or checker rows the main process accepts. */
export const PLAN_QUEUE_MAX_CHOICES = 10;
const MAX_MODEL_LENGTH = 200;
const NEVER_AUTO_PICK_NOTE = 'on your never-auto-pick list';
const NEVER_USE_NOTE = 'on your never-use list';
const USE_LAST_NOTE = 'use last';

/** One provider/account choice as the user is editing it (nothing stripped yet). */
interface RouteDraft {
  readonly key: number;
  readonly provider: string;
  readonly model: string;
  readonly accountIds: readonly string[];
  readonly copilotProfileId: string;
}

type RouteList = 'workers' | 'checkers' | 'stepUp';
type WorkerMode = 'same' | 'list';
type CheckerMode = 'auto' | 'manual';
type StepUpMode = 'stop' | 'handover';

export interface PlanQueueProviderOption {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

export interface PlanQueueAccountRow {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  /** True when the account cannot be used, so the row is drawn greyed (a "use last" note is not greyed). */
  readonly off: boolean;
  readonly note: string | null;
}

export interface PlanQueueCopilotOption {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

/** A known model for the chosen provider, offered as a suggestion in the model box. */
export interface PlanQueueModelOption {
  readonly id: string;
  readonly label: string;
}

/** Everything the template needs to draw one provider/model/account editor. */
interface RouteView {
  readonly list: RouteList;
  readonly index: number;
  /** Names the row's group of controls for assistive technology ("Worker choice 2"). */
  readonly groupLabel: string;
  readonly key: number;
  readonly draft: RouteDraft;
  readonly providerOptions: PlanQueueProviderOption[];
  /** Ties the model box to its suggestion list; unique on the page. */
  readonly modelListId: string;
  readonly modelOptions: PlanQueueModelOption[];
  readonly pooled: boolean;
  readonly accountRows: PlanQueueAccountRow[];
  readonly accountsNote: string | null;
  readonly isCopilot: boolean;
  readonly copilotOptions: PlanQueueCopilotOption[];
  readonly errors: string[];
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

function ineligibleReason(enabled: boolean, policy: 'allow-routed' | 'manual-only' | 'disabled'): string | null {
  if (!enabled) return 'turned off';
  if (policy === 'manual-only') return 'manual only';
  if (policy === 'disabled') return 'never for automatic work';
  return null;
}

/** The CLI a provider id runs as, matching the main process (`gemini` → antigravity, `openai` → codex). */
function runsAs(provider: string): string {
  return provider === 'gemini' ? 'antigravity' : provider === 'openai' ? 'codex' : provider;
}

function emptyDraft(key: number, provider: string): RouteDraft {
  return { key, provider, model: '', accountIds: [], copilotProfileId: '' };
}

/**
 * Strips empty optional fields and fields that do not apply to the provider, so
 * the saved value never carries an empty string or array.
 */
function cleanChoice(draft: RouteDraft): PlanQueueRouteChoice {
  const model = draft.model.trim();
  const accountIds = [...draft.accountIds].sort();
  return {
    provider: draft.provider,
    ...(model ? { model } : {}),
    ...(isPooledProvider(draft.provider) && accountIds.length > 0 ? { accountProfileIds: accountIds } : {}),
    ...(draft.provider === 'copilot' && draft.copilotProfileId ? { copilotProfileId: draft.copilotProfileId } : {}),
  };
}

function eventValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLSelectElement).value;
}

function eventChecked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked;
}

/**
 * Which providers and accounts Plan Queue workers and checkers may use, each
 * as a ranked list, and the stronger worker a stuck document is handed to. Edits a draft of the saved `planQueueRouting` setting (or
 * one run's routing) and mirrors the checks the main process makes when a run
 * starts, so nothing refusable can be saved.
 */
@Component({
  selector: 'app-plan-queue-routing-panel',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './plan-queue-routing-panel.component.html',
  styleUrl: './plan-queue-routing-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueRoutingPanelComponent implements OnInit {
  readonly mode = input<'saved' | 'run'>('saved');
  readonly run = input<PlanQueueRunDto | null>(null);
  private readonly injector = inject(Injector);
  protected readonly moveInProgress = signal(false);
  protected readonly canMoveInProgress = computed(() => this.mode() === 'run'
    && this.run()?.status === 'running'
    && this.run()?.items.some(item => ['preparing', 'working', 'fixing', 'awaiting-slot', 'verifying', 'landing'].includes(item.state)));
  protected readonly radioSuffix = computed(() => this.mode() === 'run' ? `-${this.run()?.id ?? 'run'}` : '');

  private readonly settingsStore = inject(SettingsStore);
  private readonly providerAccountIpc = inject(ProviderAccountIpcService);
  private readonly copilotAccountIpc = inject(CopilotAccountIpcService);
  private readonly modelCatalog = inject(UnifiedCatalogStore);

  protected readonly maxChoices = PLAN_QUEUE_MAX_CHOICES;

  private nextKey = 1;
  private lastLoadedJson: string | null = null;
  /** A run route just sent; the run's next saved value is accepted while the draft still equals it. */
  private sentJson: string | null = null;

  private readonly workerMode = signal<WorkerMode>('same');
  private readonly workerDrafts = signal<RouteDraft[]>([]);
  private readonly checkerMode = signal<CheckerMode>('auto');
  private readonly checkerDrafts = signal<RouteDraft[]>([]);
  private readonly stepUpMode = signal<StepUpMode>('stop');
  /** At most one entry: the step-up choice. */
  private readonly stepUpDrafts = signal<RouteDraft[]>([]);

  private readonly accounts = signal<ProviderAccountView[]>([]);
  private readonly copilotAccounts = signal<CopilotAccountView[]>([]);
  private readonly accountsLoaded = signal(false);
  private readonly copilotLoaded = signal(false);
  protected readonly accountsError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  protected readonly isWorkerList = computed(() => this.workerMode() === 'list');
  protected readonly isCheckerManual = computed(() => this.checkerMode() === 'manual');
  protected readonly isStepUp = computed(() => this.stepUpMode() === 'handover');

  private readonly saved = computed<PlanQueueRouting>(() => {
    // An older build sharing the settings file can write the single-worker shape back.
    if (this.mode() === 'saved') return upgradePlanQueueRouting(this.settingsStore.settings().planQueueRouting ?? DEFAULT_PLAN_QUEUE_ROUTING);
    const run = this.run();
    return run?.config.routing ?? {
      workers: [{ provider: run?.workerProvider ?? 'claude', ...(run?.workerModel ? { model: run.workerModel } : {}) }],
      verifiers: [],
    };
  });
  /** The live account rules, so greying matches what is saved (and what the queue enforces). */
  private readonly accountRules = computed(() => this.settingsStore.settings().planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES);
  // Only the current run's explicit relaxation bypasses exclusions; saved defaults still enforce them.
  private readonly excludedProviders = computed(() => {
    if (this.mode() === 'run' && this.run()?.config.relaxSettings) return new Set<string>();
    return new Set((this.settingsStore.settings().providersExcludedFromAutomation ?? []).map((id) => id.trim().toLowerCase()));
  });

  /** The value that would be saved right now (empty optional fields stripped). */
  protected readonly cleaned = computed<PlanQueueRouting>(() => {
    const stepUp = this.stepUpMode() === 'handover' ? this.stepUpDrafts()[0] : undefined;
    return {
      workers: this.workerMode() === 'list' ? this.workerDrafts().map(cleanChoice) : [],
      verifiers: this.checkerMode() === 'manual' ? this.checkerDrafts().map(cleanChoice) : [],
      ...(stepUp ? { stepUp: cleanChoice(stepUp) } : {}),
    };
  });

  protected readonly workerViews = computed<RouteView[]>(() => this.workerMode() === 'list' ? this.buildViews('workers') : []);
  protected readonly checkerViews = computed<RouteView[]>(() => this.checkerMode() === 'manual' ? this.buildViews('checkers') : []);
  protected readonly stepUpViews = computed<RouteView[]>(() => this.stepUpMode() === 'handover' ? this.buildViews('stepUp') : []);

  protected readonly workerListErrors = computed<string[]>(() => this.workerMode() === 'list' && this.workerDrafts().length === 0
    ? [`Add at least one worker choice, or choose "Same as the session that ${this.mode() === 'run' ? 'started' : 'starts'} the run".`]
    : []);

  protected readonly checkerListErrors = computed<string[]>(() => {
    if (this.checkerMode() !== 'manual') return [];
    const checkers = this.checkerDrafts();
    if (checkers.length === 0) return ['Add at least one checker, or choose "Choose automatically".'];
    if (this.workerMode() !== 'list') return [];
    // Mirrors the main process: every worker choice needs a checker that can judge it, and a
    // checker on that worker's provider needs a model from a different maker.
    const workers = this.workerDrafts();
    const stuck = workers.findIndex((worker) => !checkers.some((checker) => {
      if (runsAs(checker.provider) !== runsAs(worker.provider)) return true;
      return sameProviderCheckerCanDiffer(runsAs(worker.provider), checker.model.trim() || undefined, worker.model.trim(), (a, b) => !sameFamily(a, b));
    }));
    if (stuck < 0) return [];
    const like = workers.length > 1 ? `worker choice ${stuck + 1}` : 'the workers';
    return [`Every checker uses ${workers[stuck].provider}, like ${like}, without a model from a different maker, so nothing could check the work. Add a checker on another provider, or give one a model from a different maker (on OpenCode, also name the workers' model).`];
  });

  protected readonly stepUpErrors = computed<string[]>(() => {
    const stepUp = this.stepUpMode() === 'handover' ? this.stepUpDrafts()[0] : undefined;
    if (!stepUp) return [];
    const errors: string[] = [];
    const workers = this.workerMode() === 'list' ? this.workerDrafts() : [];
    const only = workers.length === 1 ? workers[0] : undefined;
    if (only && runsAs(only.provider) === runsAs(stepUp.provider) && only.model.trim() === stepUp.model.trim()) {
      errors.push('This is the same as the worker, so handing over would change nothing.');
    }
    // Mirrors the main process: a chosen checker list must be able to judge the stronger worker too.
    const checkers = this.checkerMode() === 'manual' ? this.checkerDrafts() : [];
    if (checkers.length > 0 && !checkers.some((checker) => runsAs(checker.provider) !== runsAs(stepUp.provider)
      || sameProviderCheckerCanDiffer(runsAs(stepUp.provider), checker.model.trim() || undefined, stepUp.model.trim(), (a, b) => !sameFamily(a, b)))) {
      errors.push(`Every checker uses ${stepUp.provider}, like the stronger worker, without a model from a different maker, so nothing could check its work. Add a checker on another provider, or choose a stronger worker on another provider.`);
    }
    return errors;
  });

  protected readonly valid = computed(() =>
    this.workerViews().every((view) => view.errors.length === 0)
    && this.checkerViews().every((view) => view.errors.length === 0)
    && this.stepUpViews().every((view) => view.errors.length === 0)
    && this.workerListErrors().length === 0
    && this.checkerListErrors().length === 0
    && this.stepUpErrors().length === 0,
  );
  protected readonly dirty = computed(
    () => JSON.stringify(this.cleaned()) !== JSON.stringify(this.normalise(this.saved())),
  );
  protected readonly canSave = computed(() => this.dirty() && this.valid() && !this.saving());
  protected readonly canAddWorker = computed(() => this.workerDrafts().length < PLAN_QUEUE_MAX_CHOICES);
  protected readonly canAddChecker = computed(() => this.checkerDrafts().length < PLAN_QUEUE_MAX_CHOICES);

  constructor() {
    // Follow the saved setting while the user has no unsaved edits, so a change
    // made elsewhere (or a save from here) is reflected without a reload.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(this.normalise(saved));
        // A run update or another setting brings the same value: keep the rows, an open list and focus.
        if (savedJson === this.lastLoadedJson) return;
        const cleanedJson = JSON.stringify(this.cleaned());
        // After a run save the main process may store more than was sent ("same as the session"
        // becomes that session's choice), so take its value while the draft is still what was sent.
        const pristine = this.lastLoadedJson === null || cleanedJson === this.lastLoadedJson || cleanedJson === this.sentJson;
        if (pristine) this.loadDraftFrom(saved);
        this.sentJson = null;
        this.lastLoadedJson = savedJson;
      });
    });
  }

  ngOnInit(): void {
    void this.loadAccounts();
    this.modelCatalog.ensureLoaded();
  }

  /** Loads the Claude/Codex/OpenCode pools and the Copilot accounts. Never throws. */
  async loadAccounts(): Promise<void> {
    const [pooled, copilot] = await Promise.allSettled([
      this.providerAccountIpc.list(),
      this.copilotAccountIpc.list(),
    ]);
    const problems: string[] = [];
    if (pooled.status === 'fulfilled') {
      this.accounts.set(pooled.value?.profiles ?? []);
      this.accountsLoaded.set(true);
    } else {
      problems.push(pooled.reason instanceof Error ? pooled.reason.message : 'Accounts could not be loaded.');
    }
    if (copilot.status === 'fulfilled') {
      this.copilotAccounts.set(copilot.value ?? []);
      this.copilotLoaded.set(true);
    } else {
      problems.push(copilot.reason instanceof Error ? copilot.reason.message : 'Copilot accounts could not be loaded.');
    }
    this.accountsError.set(problems.length > 0 ? `Account lists are unavailable (${problems.join('; ')}).` : null);
  }

  // ---- Modes ----

  setWorkerMode(mode: WorkerMode): void {
    this.workerMode.set(mode);
    if (mode === 'list' && this.workerDrafts().length === 0) this.addChoice('workers');
    this.status.set(null);
  }

  setCheckerMode(mode: CheckerMode): void {
    this.checkerMode.set(mode);
    if (mode === 'manual' && this.checkerDrafts().length === 0) this.addChoice('checkers');
    this.status.set(null);
  }

  setStepUpMode(mode: StepUpMode): void {
    this.stepUpMode.set(mode);
    if (mode === 'handover' && this.stepUpDrafts().length === 0) {
      this.stepUpDrafts.set([emptyDraft(this.nextKey++, this.firstAllowedProvider('stepUp'))]);
    }
    this.status.set(null);
  }

  // ---- Ranked lists ----

  addChoice(list: 'workers' | 'checkers'): void {
    if (!(list === 'workers' ? this.canAddWorker() : this.canAddChecker())) return;
    const provider = this.firstAllowedProvider(list);
    this.drafts(list).update((drafts) => [...drafts, emptyDraft(this.nextKey++, provider)]);
    this.status.set(null);
  }

  removeChoice(list: 'workers' | 'checkers', index: number): void {
    this.drafts(list).update((drafts) => drafts.filter((_, i) => i !== index));
    this.status.set(null);
  }

  moveChoice(list: 'workers' | 'checkers', index: number, delta: -1 | 1): void {
    const target = index + delta;
    this.drafts(list).update((drafts) => {
      if (target < 0 || target >= drafts.length) return drafts;
      const next = [...drafts];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    this.status.set(null);
  }

  // ---- Row editing ----

  setProvider(list: RouteList, index: number, provider: string): void {
    this.patchDraft(list, index, { provider, accountIds: [], copilotProfileId: '' });
  }

  setModel(list: RouteList, index: number, model: string): void {
    this.patchDraft(list, index, { model });
  }

  toggleAccount(list: RouteList, index: number, accountId: string, checked: boolean): void {
    const current = this.drafts(list)()[index]?.accountIds ?? [];
    const next = checked ? (current.includes(accountId) ? current : [...current, accountId]) : current.filter((id) => id !== accountId);
    this.patchDraft(list, index, { accountIds: next });
  }

  setCopilotAccount(list: RouteList, index: number, profileId: string): void {
    this.patchDraft(list, index, { copilotProfileId: profileId });
  }

  // ---- Save / reset ----

  resetToSaved(): void {
    this.loadDraftFrom(this.saved());
    this.status.set(null);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const value = this.cleaned();
    this.saving.set(true);
    this.status.set(null);
    try {
      if (this.mode() === 'run') {
        const run = this.run();
        if (!run) throw new Error('The run is no longer available.');
        this.sentJson = JSON.stringify(value);
        const result = await this.injector.get(PlanQueueStore).control({
          action: 'set-routing', runId: run.id, routing: value,
          ...(this.canMoveInProgress() && this.moveInProgress() ? { moveInProgress: true } : {}),
        });
        if (result.success) {
          // Moving documents in progress is a one-off; a later save must not restart them again.
          this.moveInProgress.set(false);
        } else {
          this.sentJson = null;
        }
        this.status.set(result.success
          ? { kind: 'success', text: 'Saved. New sessions in this run will use these choices.' }
          : { kind: 'error', text: result.error?.message ?? 'Could not change this run.' });
        return;
      }
      // SettingsStore.set() swallows write failures into its error signal.
      this.settingsStore.clearError();
      await this.settingsStore.set('planQueueRouting', value);
      const error = this.settingsStore.error();
      if (error) {
        // The store reloaded the old value; keep James's edits on screen so he can fix and retry.
        this.lastLoadedJson = JSON.stringify(this.normalise(this.saved()));
        this.loadDraftFrom(value);
      }
      this.status.set(error
        ? { kind: 'error', text: `Could not save: ${error}` }
        : { kind: 'success', text: 'Saved. New runs will use these choices.' });
    } catch (error) {
      this.sentJson = null;
      this.status.set({ kind: 'error', text: `Could not save: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly inputValue = eventValue;
  protected readonly inputChecked = eventChecked;

  // ---- Internals ----

  private normalise(routing: PlanQueueRouting): PlanQueueRouting {
    return {
      workers: routing.workers.map((choice, index) => cleanChoice(this.draftFromChoice(index, choice))),
      verifiers: routing.verifiers.map((choice, index) => cleanChoice(this.draftFromChoice(index, choice))),
      ...(routing.stepUp ? { stepUp: cleanChoice(this.draftFromChoice(0, routing.stepUp)) } : {}),
    };
  }

  private draftFromChoice(key: number, choice: PlanQueueRouteChoice): RouteDraft {
    return {
      key,
      provider: choice.provider,
      model: choice.model ?? '',
      accountIds: choice.accountProfileIds ?? [],
      copilotProfileId: choice.copilotProfileId ?? '',
    };
  }

  private loadDraftFrom(routing: PlanQueueRouting): void {
    this.workerMode.set(routing.workers.length > 0 ? 'list' : 'same');
    this.workerDrafts.set(routing.workers.map((choice) => this.draftFromChoice(this.nextKey++, choice)));
    this.checkerMode.set(routing.verifiers.length > 0 ? 'manual' : 'auto');
    this.checkerDrafts.set(routing.verifiers.map((choice) => this.draftFromChoice(this.nextKey++, choice)));
    this.stepUpMode.set(routing.stepUp ? 'handover' : 'stop');
    this.stepUpDrafts.set(routing.stepUp ? [this.draftFromChoice(this.nextKey++, routing.stepUp)] : []);
  }

  private drafts(list: RouteList) {
    return list === 'workers' ? this.workerDrafts : list === 'checkers' ? this.checkerDrafts : this.stepUpDrafts;
  }

  private patchDraft(list: RouteList, index: number, patch: Partial<RouteDraft>): void {
    this.drafts(list).update((drafts) => drafts.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
    this.status.set(null);
  }

  private firstAllowedProvider(list: RouteList): string {
    const excluded = this.excludedProviders();
    const definitions = list === 'checkers' ? REMOTE_REVIEWER_PROVIDER_DEFINITIONS : AUTOMATION_PROVIDER_DEFINITIONS;
    return definitions.find((def) => !excluded.has(def.id) && !excluded.has(runsAs(def.id)))?.id ?? definitions[0].id;
  }

  private providerOptions(list: RouteList, current: string): PlanQueueProviderOption[] {
    const excluded = this.excludedProviders();
    const definitions = list === 'checkers' ? REMOTE_REVIEWER_PROVIDER_DEFINITIONS : AUTOMATION_PROVIDER_DEFINITIONS;
    const options: PlanQueueProviderOption[] = definitions.map((def) => {
      // Every queue session is automatic work, so the list applies to workers too,
      // under both the id shown and the CLI it runs as (gemini runs as antigravity).
      const blocked = excluded.has(def.id) || excluded.has(runsAs(def.id));
      return {
        id: def.id,
        label: def.label,
        // A blocked provider that is already chosen stays visible so it can be changed.
        disabled: blocked,
        note: blocked ? NEVER_AUTO_PICK_NOTE : null,
      };
    });
    if (!definitions.some((def) => def.id === current)) {
      options.unshift({ id: current, label: current || 'Choose a provider', disabled: true, note: 'not available' });
    }
    return options;
  }

  /** The provider's known models (the shared catalog, or the built-in list until it loads). */
  private modelOptions(provider: string): PlanQueueModelOption[] {
    const id = runsAs(provider);
    const catalog = this.modelCatalog.displayModelsForProvider(id);
    return (catalog.length > 0 ? catalog : getModelsForProvider(id)).map((model) => ({ id: model.id, label: model.name }));
  }

  /** Why an account cannot be ticked or picked, plus the harmless "use last" label. */
  private ruleNotes(provider: string, accountId: string): { blocked: string | null; label: string | null } {
    const rules = this.accountRules();
    const matches = (ref: { provider: string; accountId: string }) => ref.provider === provider && ref.accountId === accountId;
    if (rules.never.some(matches)) return { blocked: NEVER_USE_NOTE, label: null };
    return { blocked: null, label: rules.last.some(matches) ? USE_LAST_NOTE : null };
  }

  private buildViews(list: RouteList): RouteView[] {
    const drafts = this.drafts(list)();
    return drafts.map((draft, index) => this.buildView(list, draft, index, drafts.length));
  }

  private buildView(list: RouteList, draft: RouteDraft, index: number, count: number): RouteView {
    const errors: string[] = [];
    const providerOptions = this.providerOptions(list, draft.provider);
    const chosen = providerOptions.find((option) => option.id === draft.provider);
    const role = list === 'workers' ? `worker choice ${index + 1}` : list === 'checkers' ? `checker ${index + 1}` : 'stronger worker';
    if (!chosen || chosen.note === 'not available') {
      errors.push(`The ${role} provider is not available.`);
    } else if (chosen.disabled) {
      errors.push(`The ${role} provider is ${chosen.note}. Pick another provider.`);
    }
    if (draft.model.trim().length > MAX_MODEL_LENGTH) {
      errors.push(`The ${role} model name is too long.`);
    }

    const pooled = isPooledProvider(draft.provider);
    const accountRows: PlanQueueAccountRow[] = [];
    let accountsNote: string | null = null;
    if (pooled) {
      const known = new Set<string>();
      for (const profile of this.accounts().filter((p) => p.provider === draft.provider)) {
        known.add(profile.id);
        const checked = draft.accountIds.includes(profile.id);
        const rule = this.ruleNotes(draft.provider, profile.id);
        const reason = ineligibleReason(profile.enabled, profile.automationPolicy) ?? rule.blocked;
        accountRows.push({
          id: profile.id,
          label: profile.label,
          checked,
          disabled: reason !== null && !checked,
          off: reason !== null,
          note: reason ?? rule.label,
        });
        if (reason !== null && checked) errors.push(`The ${role} account "${profile.label}" is ${reason}. Untick it.`);
      }
      if (this.accountsLoaded()) {
        for (const id of draft.accountIds.filter((accountId) => !known.has(accountId))) {
          accountRows.push({ id, label: `Unknown account (${id})`, checked: true, disabled: false, off: true, note: 'no longer exists' });
          errors.push(`The ${role} uses an account that no longer exists. Untick it.`);
        }
        if (accountRows.length === 0) accountsNote = 'No accounts are set up for this provider.';
        if (draft.provider === 'opencode' && draft.accountIds.length > 0 && !isLogicalMiMoModel(draft.model.trim())) {
          errors.push(`OpenCode accounts only apply to MiMo Token Plan models. Set the ${role} model to a xiaomi-token-plan model, or untick the accounts.`);
        }
      } else {
        accountsNote = 'Accounts could not be loaded.';
      }
    }

    const isCopilot = draft.provider === 'copilot';
    const copilotOptions: PlanQueueCopilotOption[] = [];
    if (isCopilot) {
      for (const profile of this.copilotAccounts()) {
        const rule = this.ruleNotes('copilot', profile.id);
        const reason = ineligibleReason(true, profile.automationPolicy) ?? rule.blocked;
        copilotOptions.push({ id: profile.id, label: profile.label, disabled: reason !== null, note: reason ?? rule.label });
        if (reason !== null && draft.copilotProfileId === profile.id) {
          errors.push(`The ${role} Copilot account "${profile.label}" is ${reason}. Pick another.`);
        }
      }
      if (this.copilotLoaded()
        && draft.copilotProfileId
        && !this.copilotAccounts().some((profile) => profile.id === draft.copilotProfileId)) {
        copilotOptions.unshift({ id: draft.copilotProfileId, label: `Unknown account (${draft.copilotProfileId})`, disabled: true, note: 'no longer exists' });
        errors.push(`The ${role} uses a Copilot account that no longer exists. Pick another.`);
      }
    }

    return {
      list,
      index,
      groupLabel: list === 'stepUp' ? 'Stronger worker' : `${list === 'workers' ? 'Worker choice' : 'Checker'} ${index + 1}`,
      key: draft.key,
      draft,
      providerOptions,
      modelListId: `pq-routing-models${this.radioSuffix()}-${draft.key}`,
      modelOptions: this.modelOptions(draft.provider),
      pooled,
      accountRows,
      accountsNote,
      isCopilot,
      copilotOptions,
      // Identical messages (two vanished accounts) would repeat the template's track key.
      errors: [...new Set(errors)],
      canMoveUp: index > 0,
      canMoveDown: index < count - 1,
    };
  }
}
