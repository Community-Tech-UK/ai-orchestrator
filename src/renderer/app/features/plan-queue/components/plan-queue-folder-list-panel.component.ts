import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  DEFAULT_PLAN_QUEUE_FOLDERS,
  isAbsoluteChecklistFolder,
  normalizeChecklistFolder,
  PlanQueueFoldersSchema,
} from '@contracts/schemas/plan-queue';
import { presentError } from '../../../../../shared/present-error';
import { InstanceStore } from '../../../core/state/instance.store';
import { SettingsStore } from '../../../core/state/settings.store';

interface StatusLine {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

/** Sorted so the same list always compares equal, whatever order folders were added in. */
function normalise(folders: readonly string[]): string[] {
  return folders.map((folder) => folder.trim()).sort((a, b) => a.localeCompare(b));
}

/**
 * The project folders a session may start a Plan Queue run in from another folder. Edits a draft of the saved
 * `planQueueFolders` setting. Only James can change it, here: no agent-reachable tool can add a folder.
 */
@Component({
  selector: 'app-plan-queue-folder-list-panel',
  standalone: true,
  templateUrl: './plan-queue-folder-list-panel.component.html',
  styleUrl: './plan-queue-folder-list-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueFolderListPanelComponent {
  private readonly settingsStore = inject(SettingsStore);
  private readonly instanceStore = inject(InstanceStore);

  private lastLoadedJson: string | null = null;

  protected readonly folders = signal<readonly string[]>([]);
  protected readonly newFolder = signal('');
  protected readonly saving = signal(false);
  protected readonly status = signal<StatusLine | null>(null);

  private readonly saved = computed(() => normalise(this.settingsStore.settings().planQueueFolders ?? DEFAULT_PLAN_QUEUE_FOLDERS));

  /** Folders of the sessions that are open now and not listed yet, offered while typing a folder. */
  protected readonly suggestedFolders = computed(() => {
    const listed = new Set(this.folders().map(normalizeChecklistFolder));
    const open = this.instanceStore.rootInstances().map((instance) => instance.workingDirectory)
      .filter((folder): folder is string => !!folder && !listed.has(normalizeChecklistFolder(folder)));
    return [...new Set(open)].sort();
  });

  private readonly cleaned = computed(() => normalise(this.folders()));

  protected readonly problem = computed<string | null>(() => {
    const result = PlanQueueFoldersSchema.safeParse(this.cleaned());
    if (result.success) return null;
    const [issue] = result.error.issues;
    return issue?.message ?? 'This list cannot be saved.';
  });
  protected readonly dirty = computed(() => JSON.stringify(this.cleaned()) !== JSON.stringify(this.saved()));
  protected readonly canSave = computed(() => this.dirty() && this.problem() === null && !this.saving());
  /** Typed text that is not a full path can never match a session's folder, so it is not added. */
  protected readonly newFolderNeedsFullPath = computed(() => {
    const typed = this.newFolder().trim();
    return typed.length > 0 && !isAbsoluteChecklistFolder(typed);
  });
  protected readonly canAdd = computed(() => {
    const folder = normalizeChecklistFolder(this.newFolder());
    return folder.length > 0 && !this.newFolderNeedsFullPath() && !this.folders().some((listed) => normalizeChecklistFolder(listed) === folder);
  });

  constructor() {
    // Follow the saved setting while there are no unsaved edits, so a change made elsewhere shows without a reload.
    effect(() => {
      const saved = this.saved();
      untracked(() => {
        const savedJson = JSON.stringify(saved);
        if (savedJson === this.lastLoadedJson) return;
        if (this.lastLoadedJson === null || JSON.stringify(this.cleaned()) === this.lastLoadedJson) this.folders.set(saved);
        this.lastLoadedJson = savedJson;
      });
    });
  }

  setNewFolder(value: string): void {
    this.newFolder.set(value);
  }

  addFolder(): void {
    if (!this.canAdd()) return;
    this.folders.update((folders) => [...folders, this.newFolder().trim()]);
    this.newFolder.set('');
    this.status.set(null);
  }

  removeFolder(folder: string): void {
    this.folders.update((folders) => folders.filter((listed) => listed !== folder));
    this.status.set(null);
  }

  resetToSaved(): void {
    this.folders.set(this.saved());
    this.status.set(null);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    const parsed = PlanQueueFoldersSchema.safeParse(this.cleaned());
    if (!parsed.success) return;
    const value = parsed.data;
    this.saving.set(true);
    this.status.set(null);
    try {
      // SettingsStore.set() swallows write failures into its error signal.
      this.settingsStore.clearError();
      await this.settingsStore.set('planQueueFolders', value);
      const error = this.settingsStore.error();
      // On a failure the store reloaded the old value; keep the edits on screen so they can be fixed and retried.
      this.lastLoadedJson = JSON.stringify(error ? this.saved() : normalise(value));
      if (!error) this.folders.set(normalise(value));
      this.status.set(error
        ? { kind: 'error', text: `Could not save: ${presentError(error).rawDetail}` }
        : { kind: 'success', text: 'Saved. A session can now start a run in any of these folders.' });
    } catch (error) {
      this.status.set({ kind: 'error', text: `Could not save: ${presentError(error).rawDetail}` });
    } finally {
      this.saving.set(false);
    }
  }
}
