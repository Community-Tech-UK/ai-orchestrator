import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  DEFAULT_PLAN_QUEUE_ACCOUNT_RULES,
  PlanQueueAccountRulesSchema,
  type PlanQueueAccountRef,
  type PlanQueueAccountRules,
} from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../../core/services/ipc/provider-account-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';

export type PlanQueueAccountChoice = 'normal' | 'last' | 'never';

type RuledChoice = Exclude<PlanQueueAccountChoice, 'normal'>;

interface RuleEntry {
  readonly ref: PlanQueueAccountRef;
  readonly choice: RuledChoice;
}

export interface PlanQueueAccountRuleRow {
  readonly ref: PlanQueueAccountRef;
  readonly key: string;
  readonly label: string;
  readonly note: string | null;
  readonly choice: PlanQueueAccountChoice;
  /** A saved rule names an account that is no longer in settings; saving drops it. */
  readonly missing: boolean;
}

export interface PlanQueueAccountRuleGroup {
  readonly provider: PlanQueueAccountRef['provider'];
  readonly title: string;
  readonly rows: readonly PlanQueueAccountRuleRow[];
}

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

const GROUPS: readonly { readonly provider: PlanQueueAccountRef['provider']; readonly title: string }[] = [
  { provider: 'claude', title: 'Claude' },
  { provider: 'codex', title: 'Codex' },
  { provider: 'opencode', title: 'MiMo' },
  { provider: 'copilot', title: 'Copilot' },
];

export const PLAN_QUEUE_ACCOUNT_CHOICES: readonly { readonly value: PlanQueueAccountChoice; readonly label: string }[] = [
  { value: 'normal', label: 'Use normally' },
  { value: 'last', label: 'Use last' },
  { value: 'never', label: 'Never use' },
];

function keyOf(ref: PlanQueueAccountRef): string {
  return `${ref.provider}:${ref.accountId}`;
}

/** Sorted so the same rules always compare equal, whatever order they were ticked in. */
function normalise(rules: PlanQueueAccountRules): PlanQueueAccountRules {
  const sorted = (refs: readonly PlanQueueAccountRef[]) =>
    refs.map((ref) => ({ provider: ref.provider, accountId: ref.accountId })).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return { never: sorted(rules.never), last: sorted(rules.last) };
}

/**
 * Which signed-in accounts Plan Queue sessions and automation runs must never
 * use, or use only when nothing else can run. Edits a draft of the saved
 * `planQueueAccountRules` setting. The rules never affect sessions opened by
 * hand, loops, or automations that wake an existing session.
 */
@Component({
  selector: 'app-plan-queue-account-rules-panel',
  standalone: true,
  templateUrl: './plan-queue-account-rules-panel.component.html',
  styleUrl: './plan-queue-account-rules-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueAccountRulesPanelComponent implements OnInit {
  private readonly settingsStore = inject(SettingsStore);
  private readonly providerAccountIpc = inject(ProviderAccountIpcService);
  private readonly copilotAccountIpc = inject(CopilotAccountIpcService);

  protected readonly choiceOptions = PLAN_QUEUE_ACCOUNT_CHOICES;

  private readonly pooledAccounts = signal<Awaited<ReturnType<ProviderAccountIpcService['list']>>['profiles']>([]);
  private readonly copilotAccounts = signal<Awaited<ReturnType<CopilotAccountIpcService['list']>>>([]);
  private readonly pooledLoaded = signal(false);
  private readonly copilotLoaded = signal(false);
  protected readonly accountsError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  /** The choices as the user is editing them, keyed `provider:accountId`. Absent means "Use normally". */
  private readonly entries = signal<ReadonlyMap<string, RuleEntry>>(new Map());
  private lastLoadedJson: string | null = null;

  private readonly saved = computed(() => normalise(this.settingsStore.settings().planQueueAccountRules ?? DEFAULT_PLAN_QUEUE_ACCOUNT_RULES));

  protected readonly groups = computed<PlanQueueAccountRuleGroup[]>(() => {
    const entries = this.entries();
    const known = new Set<string>();
    const rowFor = (ref: PlanQueueAccountRef, label: string, note: string | null, missing: boolean): PlanQueueAccountRuleRow => {
      const key = keyOf(ref);
      return { ref, key, label, note, choice: entries.get(key)?.choice ?? 'normal', missing };
    };
    return GROUPS.map(({ provider, title }) => {
      const rows: PlanQueueAccountRuleRow[] = [];
      if (provider === 'copilot') {
        for (const profile of this.copilotAccounts()) {
          const ref = { provider, accountId: profile.id } as const;
          known.add(keyOf(ref));
          rows.push(rowFor(ref, profile.label, null, false));
        }
      } else {
        for (const profile of this.pooledAccounts().filter((p) => p.provider === provider)) {
          const ref = { provider, accountId: profile.id } as const;
          known.add(keyOf(ref));
          // An account that is turned off is not offered, unless a rule already names it.
          if (profile.enabled || entries.has(keyOf(ref))) rows.push(rowFor(ref, profile.label, profile.enabled ? null : 'turned off', false));
        }
      }
      if (this.isLoaded(provider)) {
        for (const entry of entries.values()) {
          if (entry.ref.provider === provider && !known.has(keyOf(entry.ref))) {
            rows.push(rowFor(entry.ref, `Unknown account (${entry.ref.accountId})`, 'account no longer exists', true));
          }
        }
      }
      return { provider, title, rows };
    });
  });

  /** What would be saved now: rules for accounts that still exist (a rule on a vanished account is dropped). */
  private readonly cleaned = computed<PlanQueueAccountRules>(() => {
    const missing = new Set(this.groups().flatMap((group) => group.rows).filter((row) => row.missing).map((row) => row.key));
    const kept = [...this.entries().values()].filter((entry) => !missing.has(keyOf(entry.ref)));
    return normalise({
      never: kept.filter((entry) => entry.choice === 'never').map((entry) => entry.ref),
      last: kept.filter((entry) => entry.choice === 'last').map((entry) => entry.ref),
    });
  });

  protected readonly problem = computed<string | null>(() => {
    const result = PlanQueueAccountRulesSchema.safeParse(this.cleaned());
    return result.success ? null : (result.error.issues[0]?.message ?? 'These rules cannot be saved.');
  });
  protected readonly dirty = computed(() => JSON.stringify(this.cleaned()) !== JSON.stringify(this.saved()));
  protected readonly canSave = computed(() => this.dirty() && this.problem() === null && !this.saving());
  protected readonly hasMissing = computed(() => this.groups().some((group) => group.rows.some((row) => row.missing)));
  protected readonly hasAccounts = computed(() => this.groups().some((group) => group.rows.length > 0));

  constructor() {
    // Follow the saved setting while there are no unsaved edits, so a change
    // made elsewhere is reflected without a reload.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(saved);
        if (savedJson === this.lastLoadedJson) return;
        if (this.lastLoadedJson === null || JSON.stringify(this.draftRules()) === this.lastLoadedJson) this.loadDraftFrom(saved);
        this.lastLoadedJson = savedJson;
      });
    });
  }

  ngOnInit(): void {
    void this.loadAccounts();
  }

  /** Loads the Claude, Codex and MiMo accounts and the Copilot accounts. Never throws. */
  async loadAccounts(): Promise<void> {
    const [pooled, copilot] = await Promise.allSettled([this.providerAccountIpc.list(), this.copilotAccountIpc.list()]);
    const problems: string[] = [];
    if (pooled.status === 'fulfilled') {
      this.pooledAccounts.set(pooled.value?.profiles ?? []);
      this.pooledLoaded.set(true);
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

  setChoice(ref: PlanQueueAccountRef, choice: PlanQueueAccountChoice): void {
    const next = new Map(this.entries());
    if (choice === 'normal') next.delete(keyOf(ref));
    else next.set(keyOf(ref), { ref, choice });
    this.entries.set(next);
    this.status.set(null);
  }

  resetToSaved(): void {
    this.loadDraftFrom(this.saved());
    this.status.set(null);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const parsed = PlanQueueAccountRulesSchema.safeParse(this.cleaned());
    if (!parsed.success) return;
    const value = parsed.data;
    this.saving.set(true);
    this.status.set(null);
    try {
      // SettingsStore.set() swallows write failures into its error signal.
      this.settingsStore.clearError();
      await this.settingsStore.set('planQueueAccountRules', value);
      const error = this.settingsStore.error();
      // On a failure the store reloaded the old value; keep the edits on screen so they can be fixed and retried.
      this.lastLoadedJson = JSON.stringify(error ? this.saved() : normalise(value));
      this.loadDraftFrom(value);
      this.status.set(error
        ? { kind: 'error', text: `Could not save: ${error}` }
        : { kind: 'success', text: 'Saved. New Plan Queue and automation sessions follow these rules, and a Plan Queue session already running on a never-use account is restarted on another.' });
    } catch (error) {
      this.status.set({ kind: 'error', text: `Could not save: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.saving.set(false);
    }
  }

  protected choiceChecked(row: PlanQueueAccountRuleRow, value: PlanQueueAccountChoice): boolean {
    return row.choice === value;
  }

  // ---- Internals ----

  private isLoaded(provider: PlanQueueAccountRef['provider']): boolean {
    return provider === 'copilot' ? this.copilotLoaded() : this.pooledLoaded();
  }

  /** Every draft entry, including rules on vanished accounts, in the shape used to compare with the loaded value. */
  private draftRules(): PlanQueueAccountRules {
    const all = [...this.entries().values()];
    return normalise({
      never: all.filter((entry) => entry.choice === 'never').map((entry) => entry.ref),
      last: all.filter((entry) => entry.choice === 'last').map((entry) => entry.ref),
    });
  }

  private loadDraftFrom(rules: PlanQueueAccountRules): void {
    const next = new Map<string, RuleEntry>();
    for (const ref of rules.last) next.set(keyOf(ref), { ref, choice: 'last' });
    for (const ref of rules.never) next.set(keyOf(ref), { ref, choice: 'never' });
    this.entries.set(next);
  }
}
