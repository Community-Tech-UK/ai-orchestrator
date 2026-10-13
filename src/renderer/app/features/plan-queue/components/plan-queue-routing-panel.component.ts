import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import type { PlanQueueRouteChoice, PlanQueueRouting } from '@contracts/schemas/plan-queue';
import { sameFamily } from '../../../../../shared/models/model-family';
import { sameProviderCheckerCanDiffer } from '../../../../../shared/models/multi-maker-providers';
import { AUTOMATION_PROVIDER_DEFINITIONS } from '../../../../../shared/types/automation-provider.types';
import { isLogicalMiMoModel, isPooledProvider } from '../../../../../shared/types/provider-account.types';
import { REMOTE_REVIEWER_PROVIDER_DEFINITIONS } from '../../../../../shared/types/reviewer-provider.types';
import { CopilotAccountIpcService, type CopilotAccountView } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService, type ProviderAccountView } from '../../../core/services/ipc/provider-account-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';

/** Most checker rows the main process accepts. */
export const PLAN_QUEUE_MAX_CHECKERS = 10;
const MAX_MODEL_LENGTH = 200;
const NEVER_AUTO_PICK_NOTE = 'on your never-auto-pick list';

/** One provider/account choice as the user is editing it (nothing stripped yet). */
interface RouteDraft {
  readonly key: number;
  readonly provider: string;
  readonly model: string;
  readonly accountIds: readonly string[];
  readonly copilotProfileId: string;
}

type DraftTarget = 'worker' | number;
type WorkerMode = 'same' | 'always';
type CheckerMode = 'auto' | 'manual';

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
  readonly note: string | null;
}

export interface PlanQueueCopilotOption {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly note: string | null;
}

/** Everything the template needs to draw one provider/model/account editor. */
interface RouteView {
  readonly target: DraftTarget;
  readonly key: number;
  readonly draft: RouteDraft;
  readonly providerOptions: PlanQueueProviderOption[];
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
 * Which providers and accounts Plan Queue workers and checkers may use. Edits
 * a draft of the saved `planQueueRouting` setting and mirrors the checks the
 * main process makes when a run starts, so nothing refusable can be saved.
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
  private readonly settingsStore = inject(SettingsStore);
  private readonly providerAccountIpc = inject(ProviderAccountIpcService);
  private readonly copilotAccountIpc = inject(CopilotAccountIpcService);

  protected readonly maxCheckers = PLAN_QUEUE_MAX_CHECKERS;

  private nextKey = 1;
  private lastLoadedJson: string | null = null;

  private readonly workerMode = signal<WorkerMode>('same');
  private readonly workerDraft = signal<RouteDraft>(emptyDraft(0, 'claude'));
  private readonly checkerMode = signal<CheckerMode>('auto');
  private readonly checkerDrafts = signal<RouteDraft[]>([]);

  private readonly accounts = signal<ProviderAccountView[]>([]);
  private readonly copilotAccounts = signal<CopilotAccountView[]>([]);
  private readonly accountsLoaded = signal(false);
  private readonly copilotLoaded = signal(false);
  protected readonly accountsError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  protected readonly isWorkerAlways = computed(() => this.workerMode() === 'always');
  protected readonly isCheckerManual = computed(() => this.checkerMode() === 'manual');

  private readonly saved = computed<PlanQueueRouting>(
    () => this.settingsStore.settings().planQueueRouting ?? { worker: null, verifiers: [] },
  );
  // Trimmed and lowercased, as the main process reads the list.
  private readonly excludedProviders = computed(
    () => new Set((this.settingsStore.settings().providersExcludedFromAutomation ?? []).map((id) => id.trim().toLowerCase())),
  );

  /** The value that would be saved right now (empty optional fields stripped). */
  protected readonly cleaned = computed<PlanQueueRouting>(() => ({
    worker: this.workerMode() === 'always' ? cleanChoice(this.workerDraft()) : null,
    verifiers: this.checkerMode() === 'manual' ? this.checkerDrafts().map(cleanChoice) : [],
  }));

  protected readonly workerView = computed<RouteView | null>(() =>
    this.workerMode() === 'always' ? this.buildView('worker', this.workerDraft(), 0, 1) : null,
  );
  protected readonly checkerViews = computed<RouteView[]>(() => {
    if (this.checkerMode() !== 'manual') return [];
    const drafts = this.checkerDrafts();
    return drafts.map((draft, index) => this.buildView(index, draft, index, drafts.length));
  });

  protected readonly checkerListErrors = computed<string[]>(() => {
    if (this.checkerMode() !== 'manual') return [];
    const checkers = this.checkerDrafts();
    if (checkers.length === 0) return ['Add at least one checker, or choose "Choose automatically".'];
    if (this.workerMode() !== 'always') return [];
    // Mirrors the main process: a checker on the workers' provider needs a model from a different maker.
    const worker = this.workerDraft();
    const workerModel = worker.model.trim();
    const usable = checkers.some((checker) => {
      if (runsAs(checker.provider) !== runsAs(worker.provider)) return true;
      return sameProviderCheckerCanDiffer(runsAs(worker.provider), checker.model.trim() || undefined, workerModel, (a, b) => !sameFamily(a, b));
    });
    return usable
      ? []
      : [`Every checker uses ${worker.provider}, like the workers, without a model from a different maker, so nothing could check the work. Add a checker on another provider, or give one a model from a different maker (on OpenCode, also name the workers' model).`];
  });

  protected readonly valid = computed(() =>
    (this.workerView()?.errors.length ?? 0) === 0
    && this.checkerViews().every((view) => view.errors.length === 0)
    && this.checkerListErrors().length === 0,
  );
  protected readonly dirty = computed(
    () => JSON.stringify(this.cleaned()) !== JSON.stringify(this.normalise(this.saved())),
  );
  protected readonly canSave = computed(() => this.dirty() && this.valid() && !this.saving());
  protected readonly canAddChecker = computed(() => this.checkerDrafts().length < PLAN_QUEUE_MAX_CHECKERS);

  constructor() {
    // Follow the saved setting while the user has no unsaved edits, so a change
    // made elsewhere (or a save from here) is reflected without a reload.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(this.normalise(saved));
        const pristine = this.lastLoadedJson === null || JSON.stringify(this.cleaned()) === this.lastLoadedJson;
        if (pristine) this.loadDraftFrom(saved);
        this.lastLoadedJson = savedJson;
      });
    });
  }

  ngOnInit(): void {
    void this.loadAccounts();
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

  // ---- Worker ----

  setWorkerMode(mode: WorkerMode): void {
    this.workerMode.set(mode);
    const current = this.workerDraft().provider;
    if (mode === 'always' && (this.excludedProviders().has(current) || this.excludedProviders().has(runsAs(current)))) {
      this.setProvider('worker', this.firstAllowedProvider('worker'));
    }
    this.status.set(null);
  }

  // ---- Checkers ----

  setCheckerMode(mode: CheckerMode): void {
    this.checkerMode.set(mode);
    if (mode === 'manual' && this.checkerDrafts().length === 0) this.addChecker();
    this.status.set(null);
  }

  addChecker(): void {
    if (!this.canAddChecker()) return;
    const provider = this.firstAllowedProvider(0);
    this.checkerDrafts.update((drafts) => [...drafts, emptyDraft(this.nextKey++, provider)]);
    this.status.set(null);
  }

  removeChecker(index: number): void {
    this.checkerDrafts.update((drafts) => drafts.filter((_, i) => i !== index));
    this.status.set(null);
  }

  moveChecker(index: number, delta: -1 | 1): void {
    const target = index + delta;
    this.checkerDrafts.update((drafts) => {
      if (target < 0 || target >= drafts.length) return drafts;
      const next = [...drafts];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    this.status.set(null);
  }

  // ---- Row editing ----

  setProvider(target: DraftTarget, provider: string): void {
    this.patchDraft(target, { provider, accountIds: [], copilotProfileId: '' });
  }

  setModel(target: DraftTarget, model: string): void {
    this.patchDraft(target, { model });
  }

  toggleAccount(target: DraftTarget, accountId: string, checked: boolean): void {
    const current = this.draftFor(target)?.accountIds ?? [];
    const next = checked ? (current.includes(accountId) ? current : [...current, accountId]) : current.filter((id) => id !== accountId);
    this.patchDraft(target, { accountIds: next });
  }

  setCopilotAccount(target: DraftTarget, profileId: string): void {
    this.patchDraft(target, { copilotProfileId: profileId });
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
      worker: routing.worker ? cleanChoice(this.draftFromChoice(0, routing.worker)) : null,
      verifiers: routing.verifiers.map((choice, index) => cleanChoice(this.draftFromChoice(index, choice))),
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
    this.workerMode.set(routing.worker ? 'always' : 'same');
    this.workerDraft.set(routing.worker
      ? this.draftFromChoice(this.nextKey++, routing.worker)
      : emptyDraft(this.nextKey++, 'claude'));
    this.checkerMode.set(routing.verifiers.length > 0 ? 'manual' : 'auto');
    this.checkerDrafts.set(routing.verifiers.map((choice) => this.draftFromChoice(this.nextKey++, choice)));
  }

  private draftFor(target: DraftTarget): RouteDraft | undefined {
    return target === 'worker' ? this.workerDraft() : this.checkerDrafts()[target];
  }

  private patchDraft(target: DraftTarget, patch: Partial<RouteDraft>): void {
    if (target === 'worker') {
      this.workerDraft.update((draft) => ({ ...draft, ...patch }));
    } else {
      this.checkerDrafts.update((drafts) => drafts.map((draft, i) => (i === target ? { ...draft, ...patch } : draft)));
    }
    this.status.set(null);
  }

  private firstAllowedProvider(target: DraftTarget): string {
    const excluded = this.excludedProviders();
    const definitions = target === 'worker' ? AUTOMATION_PROVIDER_DEFINITIONS : REMOTE_REVIEWER_PROVIDER_DEFINITIONS;
    return definitions.find((def) => !excluded.has(def.id) && !excluded.has(runsAs(def.id)))?.id ?? definitions[0].id;
  }

  private providerOptions(target: DraftTarget, current: string): PlanQueueProviderOption[] {
    const excluded = this.excludedProviders();
    const definitions = target === 'worker' ? AUTOMATION_PROVIDER_DEFINITIONS : REMOTE_REVIEWER_PROVIDER_DEFINITIONS;
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

  private buildView(target: DraftTarget, draft: RouteDraft, index: number, count: number): RouteView {
    const errors: string[] = [];
    const providerOptions = this.providerOptions(target, draft.provider);
    const chosen = providerOptions.find((option) => option.id === draft.provider);
    const role = target === 'worker' ? 'worker' : `checker ${index + 1}`;
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
        const reason = ineligibleReason(profile.enabled, profile.automationPolicy);
        accountRows.push({
          id: profile.id,
          label: profile.label,
          checked,
          disabled: reason !== null && !checked,
          note: reason,
        });
        if (reason !== null && checked) errors.push(`The ${role} account "${profile.label}" is ${reason}. Untick it.`);
      }
      if (this.accountsLoaded()) {
        for (const id of draft.accountIds.filter((accountId) => !known.has(accountId))) {
          accountRows.push({ id, label: `Unknown account (${id})`, checked: true, disabled: false, note: 'no longer exists' });
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
        const reason = ineligibleReason(true, profile.automationPolicy);
        copilotOptions.push({ id: profile.id, label: profile.label, disabled: reason !== null, note: reason });
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
      target,
      key: draft.key,
      draft,
      providerOptions,
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
