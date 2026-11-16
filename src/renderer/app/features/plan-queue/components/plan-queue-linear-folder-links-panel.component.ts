import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  isAbsoluteChecklistFolder,
  normalizeChecklistFolder,
  PlanQueueLinearFolderLinksSchema,
  type PlanQueueLinearConnectionSnapshot,
  type PlanQueueLinearFolderLink,
  type PlanQueueLinearLinkReading,
  type PlanQueueLinearProject,
  type PlanQueueLinearTeamProjects,
} from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { presentError } from '../../../../../shared/present-error';

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** One project the pickers offer, with the team it was picked from (a project can belong to more than one). */
interface ProjectChoice {
  readonly key: string;
  readonly project: PlanQueueLinearProject;
  readonly teamLabel: string;
}

type ProjectRole = 'private' | 'client';

const failureText = (error: unknown): string => presentError(error).rawDetail || 'no answer';
const sameFolder = (a: string, b: string): boolean => normalizeChecklistFolder(a) === normalizeChecklistFolder(b);

/**
 * Which Linear projects belong to which project folder. James edits a draft of the saved links and saves the whole list;
 * the main process checks every folder on disk (it must be the top folder of a Git project) and saves all of it or
 * none, with a reason for each refused row. A saved link whose folder has since stopped being a project is shown with
 * its reason and is not used. With no usable Linear connection the saved links are shown read-only.
 * Project and team names come from Linear and are shown as plain text.
 */
@Component({
  selector: 'app-plan-queue-linear-folder-links-panel',
  standalone: true,
  templateUrl: './plan-queue-linear-folder-links-panel.component.html',
  styleUrl: './plan-queue-linear-folder-links-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueLinearFolderLinksPanelComponent {
  private readonly ipc = inject(PlanQueueIpcService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly instanceStore = inject(InstanceStore);

  /** Bumped by every load, so a slow older answer cannot overwrite a newer one. */
  private loadVersion = 0;
  private lastLoadedJson: string | null = null;
  /** The connection the offered projects were read for; they are read again only when it changes or failed. */
  private projectsFor: string | null = null;

  protected readonly loaded = signal(false);
  protected readonly connection = signal<PlanQueueLinearConnectionSnapshot | null>(null);
  protected readonly readings = signal<readonly PlanQueueLinearLinkReading[]>([]);
  protected readonly teams = signal<readonly PlanQueueLinearTeamProjects[]>([]);
  protected readonly projectsError = signal<string | null>(null);
  protected readonly links = signal<readonly PlanQueueLinearFolderLink[]>([]);
  protected readonly newFolder = signal('');
  protected readonly saving = signal(false);
  protected readonly rechecking = signal(false);
  protected readonly status = signal<StatusLine | null>(null);
  /** Why the main process refused each row of the last save, by row. Kept while the edits stay on screen. */
  protected readonly refusals = signal<ReadonlyMap<number, readonly string[]>>(new Map());
  protected readonly listRefusals = signal<readonly string[]>([]);

  private readonly saved = computed(() => this.settingsStore.settings().planQueueLinearFolderLinks ?? []);
  /** Both settings the page depends on, so it reloads only on a real change, here or elsewhere. */
  private readonly watchedKey = computed(() => JSON.stringify([
    this.settingsStore.settings().planQueueLinearConnection ?? null,
    this.saved(),
  ]));

  protected readonly usable = computed(() => this.connection()?.usable === true);

  protected readonly choices = computed<readonly ProjectChoice[]>(() =>
    this.teams().flatMap((team) => team.projects.map((project) => ({
      key: `${team.teamId}\u001f${project.id}`,
      project: { id: project.id, name: project.name, teamId: team.teamId, teamKey: team.teamKey },
      teamLabel: `${team.teamKey} · ${team.teamName}`,
    }))));

  /** The teams' projects not yet linked anywhere in the draft: a project can be linked to one folder only. */
  protected readonly freeTeams = computed(() => {
    const taken = new Set(this.links().flatMap((link) => this.projectsOf(link).map((project) => project.id)));
    const free = new Map<string, ProjectChoice[]>();
    for (const choice of this.choices()) {
      if (taken.has(choice.project.id)) continue;
      free.set(choice.teamLabel, [...(free.get(choice.teamLabel) ?? []), choice]);
    }
    return [...free].map(([label, projects]) => ({ label, projects }));
  });

  /** Folders of the sessions open now that are not in the draft yet, offered while typing a folder. */
  protected readonly suggestedFolders = computed(() => {
    const listed = new Set(this.links().map((link) => normalizeChecklistFolder(link.folder)));
    const open = this.instanceStore.rootInstances().map((instance) => instance.workingDirectory)
      .filter((folder): folder is string => !!folder && !listed.has(normalizeChecklistFolder(folder)));
    return [...new Set(open)].sort();
  });

  /** What the schema says is wrong with each row, in its own words, before anything is sent. */
  protected readonly rowProblems = computed(() => {
    const problems = new Map<number, string[]>();
    const whole: string[] = [];
    const result = PlanQueueLinearFolderLinksSchema.safeParse(this.links());
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

  protected readonly dirty = computed(() => JSON.stringify(this.links()) !== JSON.stringify(this.saved()));
  protected readonly canSave = computed(() => this.usable() && this.dirty() && this.rowProblems().rows.size === 0
    && this.rowProblems().whole.length === 0 && !this.saving());
  protected readonly newFolderNeedsFullPath = computed(() => {
    const typed = this.newFolder().trim();
    return typed.length > 0 && !isAbsoluteChecklistFolder(typed);
  });
  protected readonly canAdd = computed(() => {
    const folder = normalizeChecklistFolder(this.newFolder());
    return this.usable() && folder.length > 0 && !this.newFolderNeedsFullPath()
      && !this.links().some((link) => sameFolder(link.folder, folder));
  });

  constructor() {
    // Load on first show, and again whenever either saved setting changes, so a change made elsewhere shows too.
    effect(() => {
      this.watchedKey();
      untracked(() => void this.load());
    });
    // Follow the saved links while there are no unsaved edits.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(saved);
        if (savedJson === this.lastLoadedJson) return;
        if (this.lastLoadedJson === null || JSON.stringify(this.links()) === this.lastLoadedJson) this.links.set(saved);
        this.lastLoadedJson = savedJson;
      });
    });
  }

  protected projectsOf(link: PlanQueueLinearFolderLink): readonly PlanQueueLinearProject[] {
    return link.privateProject ? [link.privateProject, ...link.clientProjects] : link.clientProjects;
  }

  /** The reason a saved row's link is not used, or null. Matched by the saved folder text. */
  protected brokenReason(link: PlanQueueLinearFolderLink): string | null {
    return this.readings().find((reading) => reading.link.folder === link.folder)?.broken ?? null;
  }

  protected reasonsFor(index: number): readonly string[] {
    return [...(this.rowProblems().rows.get(index) ?? []), ...(this.refusals().get(index) ?? [])];
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    const [listed, links] = await Promise.all([this.ipc.linearList(), this.ipc.linearLinks()]);
    if (version !== this.loadVersion) return;
    this.loaded.set(true);
    if (links.success && links.data) this.readings.set(links.data.links);
    else this.status.set({ kind: 'error', text: `Could not read the saved links: ${failureText(links.error)}` });
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
    if (this.usable()) await this.loadProjects(version);
  }

  private async loadProjects(version: number): Promise<void> {
    const key = JSON.stringify(this.settingsStore.settings().planQueueLinearConnection ?? null);
    if (this.projectsFor === key && this.projectsError() === null) return;
    const response = await this.ipc.linearProjects();
    if (version !== this.loadVersion) return;
    if (response.success && response.data) {
      this.teams.set(response.data.teams);
      this.projectsError.set(null);
      this.projectsFor = key;
    } else {
      this.projectsError.set(`Could not read Linear's projects: ${failureText(response.error)}`);
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
        if (response.data.usable) await this.loadProjects(++this.loadVersion);
      } else {
        this.status.set({ kind: 'error', text: `Could not check the connection: ${failureText(response.error)}` });
      }
    } finally {
      this.rechecking.set(false);
    }
  }

  setNewFolder(value: string): void {
    this.newFolder.set(value);
  }

  addFolder(): void {
    if (!this.canAdd()) return;
    this.links.update((links) => [...links, { folder: this.newFolder().trim(), privateProject: null, clientProjects: [] }]);
    this.newFolder.set('');
    this.status.set(null);
  }

  removeFolder(index: number): void {
    this.links.update((links) => links.filter((_, at) => at !== index));
    // Reasons belong to rows: drop the removed row's and move the later ones up with their rows.
    this.refusals.update((refusals) => new Map([...refusals].filter(([at]) => at !== index).map(([at, reasons]) => [at > index ? at - 1 : at, reasons])));
    this.status.set(null);
  }

  /** Adds the project picked in a row's list. `key` is the picked option's key. */
  addProject(index: number, role: ProjectRole, key: string): void {
    const picked = this.choices().find((choice) => choice.key === key)?.project;
    if (!picked) return;
    this.editRow(index, (link) => role === 'private'
      ? { ...link, privateProject: picked }
      : { ...link, clientProjects: [...link.clientProjects, picked] });
  }

  removeProject(index: number, projectId: string): void {
    this.editRow(index, (link) => ({
      ...link,
      privateProject: link.privateProject?.id === projectId ? null : link.privateProject,
      clientProjects: link.clientProjects.filter((project) => project.id !== projectId),
    }));
  }

  private editRow(index: number, change: (link: PlanQueueLinearFolderLink) => PlanQueueLinearFolderLink): void {
    this.links.update((links) => links.map((link, at) => (at === index ? change(link) : link)));
    this.refusals.update((refusals) => {
      const next = new Map(refusals);
      next.delete(index);
      return next;
    });
    this.status.set(null);
  }

  resetToSaved(): void {
    this.links.set(this.saved());
    this.refusals.set(new Map());
    this.listRefusals.set([]);
    this.status.set(null);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.status.set(null);
    this.refusals.set(new Map());
    this.listRefusals.set([]);
    try {
      const response = await this.ipc.linearLinksSave(this.links());
      if (!response.success || !response.data) {
        this.status.set({ kind: 'error', text: `Could not save: ${failureText(response.error)}` });
        return;
      }
      const result = response.data;
      if (result.saved) {
        this.lastLoadedJson = JSON.stringify(result.links);
        this.links.set(result.links);
        this.status.set({ kind: 'success', text: 'Saved. A session can now start a run in any linked folder.' });
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
