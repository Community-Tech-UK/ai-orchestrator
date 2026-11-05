import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  DEFAULT_PLAN_QUEUE_FOLDER_CHECKLISTS,
  isAbsoluteChecklistFolder,
  normalizeChecklistFolder,
  PlanQueueFolderChecklistsSchema,
  type PlanQueueFolderChecklist,
} from '@contracts/schemas/plan-queue';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';

interface DraftRow {
  readonly id: number;
  readonly folder: string;
  /** One command per line, as typed. */
  readonly verifierText: string;
  readonly postMergeText: string;
}

type DraftField = 'folder' | 'verifierText' | 'postMergeText';

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

function commandsOf(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function toChecklist(row: DraftRow): PlanQueueFolderChecklist {
  return { folder: row.folder.trim(), verifierGates: commandsOf(row.verifierText), postMergeGate: commandsOf(row.postMergeText) };
}

/** Sorted by folder so the same lists always compare equal, whatever order they were added in. */
function normalise(lists: readonly PlanQueueFolderChecklist[]): PlanQueueFolderChecklist[] {
  return lists
    .map((list) => ({ folder: list.folder, verifierGates: [...list.verifierGates], postMergeGate: [...list.postMergeGate] }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * The checks Plan Queue runs for each project folder: before a checker reviews
 * a document, and after merging a moved base branch. Edits a draft of the saved
 * `planQueueFolderChecklists` setting. A folder with a saved list always uses
 * it, whatever commands a session passes when it starts a run.
 */
@Component({
  selector: 'app-plan-queue-folder-checklists-panel',
  standalone: true,
  templateUrl: './plan-queue-folder-checklists-panel.component.html',
  styleUrl: './plan-queue-folder-checklists-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueFolderChecklistsPanelComponent {
  private readonly settingsStore = inject(SettingsStore);
  private readonly instanceStore = inject(InstanceStore);

  private nextRowId = 1;
  private lastLoadedJson: string | null = null;

  protected readonly rows = signal<readonly DraftRow[]>([]);
  protected readonly newFolder = signal('');
  protected readonly saving = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  private readonly saved = computed(() => normalise(this.settingsStore.settings().planQueueFolderChecklists ?? DEFAULT_PLAN_QUEUE_FOLDER_CHECKLISTS));

  /** Folders of the sessions that are open now and not listed yet, offered while typing a folder. */
  protected readonly suggestedFolders = computed(() => {
    const listed = new Set(this.rows().map((row) => normalizeChecklistFolder(row.folder)));
    const folders = this.instanceStore.rootInstances().map((instance) => instance.workingDirectory).filter((folder): folder is string => !!folder && !listed.has(normalizeChecklistFolder(folder)));
    return [...new Set(folders)].sort();
  });

  private readonly cleaned = computed(() => normalise(this.rows().map(toChecklist)));

  protected readonly problem = computed<string | null>(() => {
    const result = PlanQueueFolderChecklistsSchema.safeParse(this.cleaned());
    return result.success ? null : (result.error.issues[0]?.message ?? 'These checks cannot be saved.');
  });
  protected readonly dirty = computed(() => JSON.stringify(this.cleaned()) !== JSON.stringify(this.saved()));
  protected readonly canSave = computed(() => this.dirty() && this.problem() === null && !this.saving());
  /** Typed text that is not a full path: a run can never start in it, so it is not added. */
  protected readonly newFolderNeedsFullPath = computed(() => {
    const typed = this.newFolder().trim();
    return typed.length > 0 && !isAbsoluteChecklistFolder(typed);
  });
  protected readonly canAdd = computed(() => {
    const folder = normalizeChecklistFolder(this.newFolder());
    return folder.length > 0 && !this.newFolderNeedsFullPath() && !this.rows().some((row) => normalizeChecklistFolder(row.folder) === folder);
  });

  constructor() {
    // Follow the saved setting while there are no unsaved edits, so a change
    // made elsewhere is reflected without a reload.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(saved);
        if (savedJson === this.lastLoadedJson) return;
        if (this.lastLoadedJson === null || JSON.stringify(this.cleaned()) === this.lastLoadedJson) this.loadDraftFrom(saved);
        this.lastLoadedJson = savedJson;
      });
    });
  }

  setNewFolder(value: string): void {
    this.newFolder.set(value);
  }

  addFolder(): void {
    if (!this.canAdd()) return;
    this.rows.update((rows) => [...rows, { id: this.nextRowId++, folder: this.newFolder().trim(), verifierText: '', postMergeText: '' }]);
    this.newFolder.set('');
    this.status.set(null);
  }

  setField(id: number, field: DraftField, value: string): void {
    this.rows.update((rows) => rows.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
    this.status.set(null);
  }

  removeFolder(id: number): void {
    this.rows.update((rows) => rows.filter((row) => row.id !== id));
    this.status.set(null);
  }

  resetToSaved(): void {
    this.loadDraftFrom(this.saved());
    this.status.set(null);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const parsed = PlanQueueFolderChecklistsSchema.safeParse(this.cleaned());
    if (!parsed.success) return;
    const value = parsed.data;
    this.saving.set(true);
    this.status.set(null);
    try {
      // SettingsStore.set() swallows write failures into its error signal.
      this.settingsStore.clearError();
      await this.settingsStore.set('planQueueFolderChecklists', value);
      const error = this.settingsStore.error();
      // On a failure the store reloaded the old value; keep the edits on screen so they can be fixed and retried.
      this.lastLoadedJson = JSON.stringify(error ? this.saved() : normalise(value));
      if (!error) this.loadDraftFrom(value);
      this.status.set(error
        ? { kind: 'error', text: `Could not save: ${error}` }
        : { kind: 'success', text: 'Saved. Runs started from now on use these checks for their folder; runs already going keep theirs.' });
    } catch (error) {
      this.status.set({ kind: 'error', text: `Could not save: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      this.saving.set(false);
    }
  }

  private loadDraftFrom(lists: readonly PlanQueueFolderChecklist[]): void {
    this.rows.set(lists.map((list) => ({
      id: this.nextRowId++,
      folder: list.folder,
      verifierText: list.verifierGates.join('\n'),
      postMergeText: list.postMergeGate.join('\n'),
    })));
  }
}
