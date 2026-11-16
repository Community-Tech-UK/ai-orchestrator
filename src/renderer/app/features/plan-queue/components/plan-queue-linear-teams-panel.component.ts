import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  PlanQueueLinearTeamsSchema,
  type PlanQueueLinearConnectionSnapshot,
  type PlanQueueLinearFolderLink,
  type PlanQueueLinearStatus,
  type PlanQueueLinearTeam,
  type PlanQueueLinearTeamCheck,
  type PlanQueueLinearTeamChoice,
  type PlanQueueLinearTeamChoices,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { SettingsStore } from '../../../core/state/settings.store';
import { presentError } from '../../../../../shared/present-error';

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

type StatusField = 'startedStatus' | 'handBackStatus' | 'landedStatus' | 'doneStatus';

/** A team's rules while James edits them: a status can be missing until he chooses one. */
interface DraftTeam {
  readonly teamId: string;
  readonly teamKey: string;
  readonly teamName: string;
  readonly ownership: 'own' | 'client';
  readonly startedStatus: PlanQueueLinearStatus | null;
  readonly handBackStatus: PlanQueueLinearStatus | null;
  readonly landedStatus: PlanQueueLinearStatus | null;
  readonly doneStatus: PlanQueueLinearStatus | null;
  readonly providers: readonly string[];
}

/** The status fields the form shows, in order. The done status is for James's own teams only. */
const STATUS_FIELDS: readonly { field: StatusField; label: string; ownOnly: boolean }[] = [
  { field: 'startedStatus', label: 'When work starts', ownOnly: false },
  { field: 'handBackStatus', label: 'When a ticket is handed back', ownOnly: false },
  { field: 'landedStatus', label: 'When the code lands', ownOnly: false },
  { field: 'doneStatus', label: 'When the work is done', ownOnly: true },
];

/** Linear's own kind words, in plain English. A word not listed is shown as Linear wrote it. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'not started',
  started: 'in progress',
  completed: 'done',
  canceled: 'cancelled',
};

const failureText = (error: unknown): string => presentError(error).rawDetail || 'no answer';
const toDraft = (team: PlanQueueLinearTeam): DraftTeam => ({ ...team });

/**
 * The rules for each Linear team that has a linked project: whether it is one of James's own teams or a client team,
 * which status Plan Queue sets when work starts, is handed back and lands (and, for his own teams, is done), and which
 * providers may be sent the team's ticket text. James edits a draft and presses Save; the main process checks every
 * chosen status against Linear and saves all of it or none of it, with a reason for each refused row. The checks of
 * each saved team (still there, statuses unchanged, private, only member) are shown on its row.
 * Team, status and person names come from Linear and are shown as plain text.
 */
@Component({
  selector: 'app-plan-queue-linear-teams-panel',
  standalone: true,
  templateUrl: './plan-queue-linear-teams-panel.component.html',
  styleUrl: './plan-queue-linear-teams-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueLinearTeamsPanelComponent {
  private readonly ipc = inject(PlanQueueIpcService);
  private readonly settingsStore = inject(SettingsStore);

  /** Bumped by every load, so a slow older answer cannot overwrite a newer one. */
  private loadVersion = 0;
  private lastLoadedJson: string | null = null;

  protected readonly loaded = signal(false);
  protected readonly connection = signal<PlanQueueLinearConnectionSnapshot | null>(null);
  protected readonly choices = signal<PlanQueueLinearTeamChoices | null>(null);
  protected readonly choicesError = signal<string | null>(null);
  protected readonly checks = signal<ReadonlyMap<string, PlanQueueLinearTeamCheck>>(new Map());
  protected readonly checksError = signal<string | null>(null);
  protected readonly draft = signal<readonly DraftTeam[]>([]);
  protected readonly saving = signal(false);
  protected readonly rechecking = signal(false);
  protected readonly checking = signal(false);
  protected readonly status = signal<StatusLine | null>(null);
  /** Why the main process refused each row of the last save, by row. Kept while the edits stay on screen. */
  protected readonly refusals = signal<ReadonlyMap<number, readonly string[]>>(new Map());
  protected readonly listRefusals = signal<readonly string[]>([]);

  protected readonly saved = computed(() => this.settingsStore.settings().planQueueLinearTeams ?? []);
  private readonly links = computed<readonly PlanQueueLinearFolderLink[]>(() => this.settingsStore.settings().planQueueLinearFolderLinks ?? []);
  /** The settings the page depends on, so it reloads only on a real change, here or elsewhere. */
  private readonly watchedKey = computed(() => JSON.stringify([
    this.settingsStore.settings().planQueueLinearConnection ?? null,
    this.links(),
    this.saved(),
  ]));

  protected readonly usable = computed(() => this.connection()?.usable === true);

  /** Teams with a linked project and no rules yet: offered as "Set up rules". */
  protected readonly teamsToSetUp = computed(() => {
    const have = new Set(this.draft().map((team) => team.teamId));
    const found = new Map<string, { teamId: string; teamKey: string }>();
    for (const link of this.links()) {
      for (const project of link.privateProject ? [link.privateProject, ...link.clientProjects] : link.clientProjects) {
        if (!have.has(project.teamId)) found.set(project.teamId, { teamId: project.teamId, teamKey: project.teamKey });
      }
    }
    return [...found.values()].sort((a, b) => a.teamKey.localeCompare(b.teamKey));
  });

  protected readonly providers = computed(() => this.choices()?.providers ?? []);

  /** Rows that still need a status chosen, by row, in words. */
  private readonly missing = computed(() => this.draft().map((team) => STATUS_FIELDS
    .filter(({ field, ownOnly }) => (!ownOnly || team.ownership === 'own') && team[field] === null)
    .map(({ label }) => label.toLowerCase())));

  /** What the schema says is wrong with each row, in its own words, before anything is sent. */
  protected readonly rowProblems = computed(() => {
    const problems = new Map<number, string[]>();
    this.missing().forEach((labels, index) => {
      if (labels.length > 0) problems.set(index, [`Choose a status for: ${labels.join(', ')}.`]);
    });
    const whole: string[] = [];
    if (problems.size > 0) return { rows: problems, whole };
    const result = PlanQueueLinearTeamsSchema.safeParse(this.draft().map((team) => this.toEntry(team)));
    if (!result.success) {
      for (const issue of result.error.issues) {
        const [first] = issue.path;
        const text = issue.code === 'custom' ? issue.message : 'This row has a value that cannot be saved.';
        if (typeof first === 'number') problems.set(first, [...(problems.get(first) ?? []), text]);
        else whole.push(text);
      }
    }
    return { rows: problems, whole };
  });

  protected readonly dirty = computed(() => JSON.stringify(this.draft()) !== JSON.stringify(this.saved().map(toDraft)));
  protected readonly canSave = computed(() => this.usable() && this.dirty() && this.rowProblems().rows.size === 0
    && this.rowProblems().whole.length === 0 && !this.saving());

  constructor() {
    // Load on first show, and again whenever a saved setting it depends on changes, so a change made elsewhere shows too.
    effect(() => {
      this.watchedKey();
      untracked(() => void this.load());
    });
    // Follow the saved rules while there are no unsaved edits.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(saved.map(toDraft));
        if (savedJson === this.lastLoadedJson) return;
        if (this.lastLoadedJson === null || JSON.stringify(this.draft()) === this.lastLoadedJson) this.draft.set(saved.map(toDraft));
        this.lastLoadedJson = savedJson;
      });
    });
  }

  // --- What each row shows -----------------------------------------------------------------------------------------

  protected choiceFor(team: { teamId: string }): PlanQueueLinearTeamChoice | undefined {
    return this.choices()?.teams.find((choice) => choice.teamId === team.teamId);
  }

  /** Linear's statuses for the team, plus a chosen one Linear no longer lists, so the box never shows a blank. */
  protected statusOptions(team: DraftTeam, field: StatusField): readonly { id: string; label: string }[] {
    const choice = this.choiceFor(team);
    const live = (choice?.statuses ?? []).map((status) => ({ id: status.id, label: `${status.name} (${this.kindWords(status.kind)})` }));
    const chosen = team[field];
    if (chosen && !live.some((option) => option.id === chosen.id)) {
      live.unshift({ id: chosen.id, label: choice ? `${chosen.name} (no longer in Linear)` : chosen.name });
    }
    return live;
  }

  protected kindWords(kind: string): string {
    return KIND_WORDS[kind] ?? kind;
  }

  protected statusFields(team: DraftTeam): readonly { field: StatusField; label: string }[] {
    return STATUS_FIELDS.filter(({ ownOnly }) => !ownOnly || team.ownership === 'own');
  }

  protected chosenId(team: DraftTeam, field: StatusField): string {
    return team[field]?.id ?? '';
  }

  protected providerOn(team: DraftTeam, id: string): boolean {
    return team.providers.includes(id);
  }

  /** The saved rules' checks, shown only while the row is as saved: the checks are about what is saved. */
  protected checkFor(team: DraftTeam): PlanQueueLinearTeamCheck | null {
    const saved = this.saved().find((entry) => entry.teamId === team.teamId);
    if (!saved || JSON.stringify(toDraft(saved)) !== JSON.stringify(team)) return null;
    return this.checks().get(team.teamId) ?? null;
  }

  protected isSaved(team: DraftTeam): boolean {
    return this.saved().some((entry) => entry.teamId === team.teamId);
  }

  protected resultWords(result: string): string {
    return result === 'ok' ? 'Fine' : result === 'problem' ? 'Problem' : 'Cannot be checked';
  }

  protected reasonsFor(index: number): readonly string[] {
    return [...(this.rowProblems().rows.get(index) ?? []), ...(this.refusals().get(index) ?? [])];
  }

  /** A saved team's row, as text, for the read-only view. */
  protected savedSummary(team: PlanQueueLinearTeam): string {
    const names = this.choices()?.providers ?? [];
    const allowed = team.providers.map((id) => names.find((provider) => provider.id === id)?.label ?? id);
    return allowed.length > 0 ? `Ticket text may go to: ${allowed.join(', ')}.` : 'No provider may see this team\'s ticket text.';
  }

  // --- Loading ------------------------------------------------------------------------------------------------------

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    const listed = await this.ipc.linearList();
    if (version !== this.loadVersion) return;
    this.loaded.set(true);
    if (!listed.success || !listed.data) {
      this.connection.set(null);
      this.status.set({ kind: 'error', text: `Could not read the Linear connection: ${failureText(listed.error)}` });
      return;
    }
    this.connection.set(listed.data.connection);
    // After a restart the first check is still running; wait for it so the panel does not stay read-only.
    if (listed.data.connection.state === 'checking') {
      const checked = await this.ipc.linearCheck();
      if (version !== this.loadVersion) return;
      if (checked.success && checked.data) this.connection.set(checked.data);
    }
    if (this.usable()) await this.loadChoicesAndChecks(version);
  }

  private async loadChoicesAndChecks(version: number): Promise<void> {
    const [choices, checks] = await Promise.all([this.ipc.linearTeamChoices(), this.ipc.linearTeamsCheck()]);
    if (version !== this.loadVersion) return;
    if (choices.success && choices.data) {
      this.choices.set(choices.data);
      this.choicesError.set(null);
    } else {
      this.choicesError.set(`Could not read Linear's teams: ${failureText(choices.error)}`);
    }
    this.applyChecks(checks);
  }

  private applyChecks(response: Awaited<ReturnType<PlanQueueIpcService['linearTeamsCheck']>>): void {
    if (response.success && response.data) {
      this.checks.set(new Map(response.data.teams.map((check) => [check.teamId, check])));
      this.checksError.set(null);
    } else {
      this.checksError.set(`Could not check the teams: ${failureText(response.error)}`);
    }
  }

  /** Checks the connection again, for when it was fixed on the connection panel above. */
  async recheck(): Promise<void> {
    if (this.rechecking()) return;
    this.rechecking.set(true);
    try {
      const response = await this.ipc.linearCheck();
      if (response.success && response.data) {
        this.connection.set(response.data);
        if (response.data.usable) await this.loadChoicesAndChecks(++this.loadVersion);
      } else {
        this.status.set({ kind: 'error', text: `Could not check the connection: ${failureText(response.error)}` });
      }
    } finally {
      this.rechecking.set(false);
    }
  }

  /** Runs the team checks again and shows them on each row. */
  async checkTeams(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      this.applyChecks(await this.ipc.linearTeamsCheck());
    } finally {
      this.checking.set(false);
    }
  }

  // --- Editing ------------------------------------------------------------------------------------------------------

  /** Starts a client team's rules from what is offered, which James then confirms and saves. */
  setUpTeam(teamId: string): void {
    const found = this.teamsToSetUp().find((team) => team.teamId === teamId);
    if (!found) return;
    const choice = this.choiceFor(found);
    const offered = choice?.offered;
    this.draft.update((draft) => [...draft, {
      teamId,
      teamKey: choice?.teamKey ?? found.teamKey,
      teamName: choice?.teamName ?? found.teamKey,
      // A new row starts as a client team, the safer choice.
      ownership: 'client',
      startedStatus: offered?.startedStatus ?? null,
      handBackStatus: offered?.handBackStatus ?? null,
      landedStatus: offered?.landedStatus ?? null,
      doneStatus: null,
      providers: [],
    }]);
    this.status.set(null);
  }

  removeTeam(index: number): void {
    this.draft.update((draft) => draft.filter((_, at) => at !== index));
    // Reasons belong to rows: drop the removed row's and move the later ones up with their rows.
    this.refusals.update((refusals) => new Map([...refusals].filter(([at]) => at !== index).map(([at, reasons]) => [at > index ? at - 1 : at, reasons])));
    this.status.set(null);
  }

  setOwnership(index: number, ownership: 'own' | 'client'): void {
    this.editRow(index, (team) => {
      if (team.ownership === ownership) return team;
      if (ownership === 'client') return { ...team, ownership, doneStatus: null };
      const offered = this.choiceFor(team)?.offered;
      // His saved routing is only a starting point for the providers; he still has to save.
      const start = team.providers.length === 0 ? (this.choices()?.routingProviders ?? []) : team.providers;
      return { ...team, ownership, doneStatus: team.doneStatus ?? offered?.doneStatus ?? null, providers: start };
    });
  }

  setStatus(index: number, field: StatusField, id: string): void {
    this.editRow(index, (team) => {
      const live = this.choiceFor(team)?.statuses.find((status) => status.id === id);
      const kept = team[field]?.id === id ? team[field] : null;
      return { ...team, [field]: live ?? kept ?? null };
    });
  }

  setProvider(index: number, id: string, on: boolean): void {
    this.editRow(index, (team) => {
      const without = team.providers.filter((provider) => provider !== id);
      return { ...team, providers: on ? [...without, id] : without };
    });
  }

  private editRow(index: number, change: (team: DraftTeam) => DraftTeam): void {
    this.draft.update((draft) => draft.map((team, at) => (at === index ? change(team) : team)));
    this.refusals.update((refusals) => {
      const next = new Map(refusals);
      next.delete(index);
      return next;
    });
    this.status.set(null);
  }

  resetToSaved(): void {
    this.draft.set(this.saved().map(toDraft));
    this.refusals.set(new Map());
    this.listRefusals.set([]);
    this.status.set(null);
  }

  /** A complete row as the schema and the save expect it. Only called once no status is missing. */
  private toEntry(team: DraftTeam): PlanQueueLinearTeam {
    return { ...team, providers: [...team.providers] } as PlanQueueLinearTeam;
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.status.set(null);
    this.refusals.set(new Map());
    this.listRefusals.set([]);
    try {
      const response = await this.ipc.linearTeamsSave(this.draft().map((team) => this.toEntry(team)));
      if (!response.success || !response.data) {
        this.status.set({ kind: 'error', text: `Could not save: ${failureText(response.error)}` });
        return;
      }
      const result = response.data;
      if (result.saved) {
        this.lastLoadedJson = JSON.stringify(result.teams.map(toDraft));
        this.draft.set(result.teams.map(toDraft));
        this.status.set({ kind: 'success', text: 'Saved. Plan Queue uses these rules for Linear runs.' });
        void this.load();
        return;
      }
      // Nothing was saved. The edits stay on screen, with the reason for each refused row beside it.
      const rows = new Map<number, string[]>();
      const whole: string[] = [];
      for (const refusal of result.refused) {
        if (refusal.index === null) whole.push(refusal.reason);
        else rows.set(refusal.index, [...(rows.get(refusal.index) ?? []), refusal.reason]);
      }
      this.refusals.set(rows);
      this.listRefusals.set(whole);
      this.status.set({ kind: 'error', text: 'Nothing was saved. The rows below say what to fix.' });
    } finally {
      this.saving.set(false);
    }
  }
}
