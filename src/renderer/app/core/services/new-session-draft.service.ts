import { Injectable, computed, signal } from '@angular/core';
import type { ProviderType } from './provider-state.service';

@Injectable({ providedIn: 'root' })
export class NewSessionDraftService {
  private readonly storageKey = 'new-session-drafts:v1';
  private readonly defaultDraftKey = '__default__';
  private persistHandle: number | null = null;
  private pendingFilesByKey = signal<Record<string, File[]>>({});

  private state = signal(this.loadState());

  readonly revision = computed(() => this.state().revision);
  readonly activeKey = computed(() => this.state().activeKey);
  readonly activeDraft = computed(() => this.getDraftForKey(this.state().activeKey));
  readonly workingDirectory = computed(() => this.activeDraft().workingDirectory);
  readonly prompt = computed(() => this.activeDraft().prompt);
  readonly provider = computed(() => this.activeDraft().provider);
  readonly model = computed(() => this.activeDraft().model);
  readonly pendingFolders = computed(() => this.activeDraft().pendingFolders);
  readonly yoloMode = computed(() => this.activeDraft().yoloMode);
  readonly nodeId = computed(() => this.activeDraft().nodeId);
  readonly updatedAt = computed(() => this.activeDraft().updatedAt);
  readonly pendingFiles = computed(() => this.pendingFilesByKey()[this.state().activeKey] ?? []);
  readonly hasActiveContent = computed(() => this.draftHasContent(this.activeDraft()));

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.persistNow());
    }
  }

  open(workingDirectory?: string | null, nodeId?: string | null): void {
    const normalized = this.normalizePath(workingDirectory);
    const draftKey = this.getDraftKey(normalized);
    this.patchState((current) => {
      const draft = this.ensureDraft(current.drafts[draftKey], normalized);
      return {
        ...current,
        activeKey: draftKey,
        drafts: {
          ...current.drafts,
          [draftKey]: nodeId !== undefined ? { ...draft, nodeId: nodeId ?? null } : draft,
        },
        revision: current.revision + 1,
      };
    });
  }

  setWorkingDirectory(workingDirectory?: string | null): void {
    const normalized = this.normalizePath(workingDirectory);
    const nextKey = this.getDraftKey(normalized);

    this.patchState((current) => {
      const currentDraft = this.getDraftForState(current, current.activeKey);
      const nextDraft = this.ensureDraft(current.drafts[nextKey], normalized);
      const nextDrafts = {
        ...current.drafts,
        [nextKey]: nextDraft,
      };

      if (
        current.activeKey === this.defaultDraftKey &&
        nextKey !== this.defaultDraftKey &&
        this.draftHasContent(currentDraft) &&
        !this.draftHasContent(nextDraft)
      ) {
        nextDrafts[nextKey] = {
          ...nextDraft,
          prompt: currentDraft.prompt,
          provider: currentDraft.provider,
          model: currentDraft.model,
          yoloMode: currentDraft.yoloMode,
          pendingFolders: [...currentDraft.pendingFolders],
          updatedAt: Date.now(),
        };
        nextDrafts[this.defaultDraftKey] = {
          ...currentDraft,
          prompt: '',
          provider: null,
          model: null,
          yoloMode: null,
          pendingFolders: [],
        };
        this.pendingFilesByKey.update((filesByKey) => {
          const currentFiles = filesByKey[this.defaultDraftKey] ?? [];
          const nextFiles = filesByKey[nextKey] ?? [];
          return {
            ...filesByKey,
            [this.defaultDraftKey]: [],
            [nextKey]: nextFiles.length > 0 ? nextFiles : currentFiles,
          };
        });
      }

      if (current.activeKey === nextKey && currentDraft.workingDirectory === normalized) {
        return current;
      }

      return {
        ...current,
        activeKey: nextKey,
        drafts: nextDrafts,
        revision: current.revision + 1,
      };
    });
  }

  setPrompt(prompt: string): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      prompt,
      updatedAt: Date.now(),
    }));
  }

  setProvider(provider: ProviderType | null): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      provider,
      updatedAt: Date.now(),
    }));
  }

  setModel(model: string | null): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      model,
      updatedAt: Date.now(),
    }));
  }

  setNodeId(nodeId: string | null): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      nodeId,
      updatedAt: Date.now(),
    }));
  }

  setYoloMode(yoloMode: boolean | null): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      yoloMode,
      updatedAt: Date.now(),
    }));
  }

  addPendingFolder(folderPath: string): void {
    const normalized = this.normalizePath(folderPath);
    if (!normalized) {
      return;
    }

    this.updateActiveDraft((draft) => {
      if (draft.pendingFolders.includes(normalized)) {
        return draft;
      }

      return {
        ...draft,
        pendingFolders: [...draft.pendingFolders, normalized],
        updatedAt: Date.now(),
      };
    });
  }

  removePendingFolder(folderPath: string): void {
    const normalized = this.normalizePath(folderPath);
    if (!normalized) {
      return;
    }

    this.updateActiveDraft((draft) => {
      const pendingFolders = draft.pendingFolders.filter((entry) => entry !== normalized);
      if (pendingFolders.length === draft.pendingFolders.length) {
        return draft;
      }

      return {
        ...draft,
        pendingFolders,
        updatedAt: Date.now(),
      };
    });
  }

  clearPendingFolders(): void {
    this.updateActiveDraft((draft) => (
      draft.pendingFolders.length === 0
        ? draft
        : {
            ...draft,
            pendingFolders: [],
            updatedAt: Date.now(),
          }
    ));
  }

  addPendingFiles(files: File[]): void {
    if (files.length === 0) {
      return;
    }

    const activeKey = this.state().activeKey;
    this.pendingFilesByKey.update((current) => ({
      ...current,
      [activeKey]: [...(current[activeKey] ?? []), ...files],
    }));
    this.bumpRevision();
  }

  removePendingFile(file: File): void {
    const activeKey = this.state().activeKey;
    this.pendingFilesByKey.update((current) => {
      const files = current[activeKey] ?? [];
      const nextFiles = files.filter((candidate) => candidate !== file);
      if (nextFiles.length === files.length) {
        return current;
      }

      return {
        ...current,
        [activeKey]: nextFiles,
      };
    });
    this.bumpRevision();
  }

  clearPendingFiles(): void {
    const activeKey = this.state().activeKey;
    this.pendingFilesByKey.update((current) => ({
      ...current,
      [activeKey]: [],
    }));
    this.bumpRevision();
  }

  clearActiveComposer(): void {
    const activeKey = this.state().activeKey;
    this.updateActiveDraft((draft) => ({
      ...draft,
      prompt: '',
      pendingFolders: [],
      updatedAt: Date.now(),
    }));
    const hadFiles = (this.pendingFilesByKey()[activeKey] ?? []).length > 0;
    if (hadFiles) {
      this.pendingFilesByKey.update((current) => ({
        ...current,
        [activeKey]: [],
      }));
      this.bumpRevision();
    }
  }

  hasSavedDraftFor(workingDirectory?: string | null): boolean {
    const normalized = this.normalizePath(workingDirectory);
    const draft = this.state().drafts[this.getDraftKey(normalized)];
    if (!draft) {
      return false;
    }
    return this.draftHasContent(draft) || (this.pendingFilesByKey()[this.getDraftKey(normalized)]?.length ?? 0) > 0;
  }

  getDraftUpdatedAt(workingDirectory?: string | null): number | null {
    const normalized = this.normalizePath(workingDirectory);
    return this.state().drafts[this.getDraftKey(normalized)]?.updatedAt ?? null;
  }

  private loadState(): NewSessionDraftStoreState {
    const fallbackDraft = this.createEmptyDraft(null);
    if (typeof window === 'undefined') {
      return {
        activeKey: this.defaultDraftKey,
        drafts: {
          [this.defaultDraftKey]: fallbackDraft,
        },
        revision: 0,
      };
    }

    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) {
        return {
          activeKey: this.defaultDraftKey,
          drafts: {
            [this.defaultDraftKey]: fallbackDraft,
          },
          revision: 0,
        };
      }

      const parsed = JSON.parse(raw) as PersistedNewSessionDraftStoreState | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !parsed.drafts) {
        return {
          activeKey: this.defaultDraftKey,
          drafts: {
            [this.defaultDraftKey]: fallbackDraft,
          },
          revision: 0,
        };
      }

      const drafts = Object.fromEntries(
        Object.entries(parsed.drafts).map(([key, draft]) => [
          key,
          this.hydrateDraft(draft),
        ])
      );
      const activeKey = parsed.activeKey && drafts[parsed.activeKey]
        ? parsed.activeKey
        : this.defaultDraftKey;

      if (!drafts[this.defaultDraftKey]) {
        drafts[this.defaultDraftKey] = fallbackDraft;
      }

      return {
        activeKey,
        drafts,
        revision: 0,
      };
    } catch {
      return {
        activeKey: this.defaultDraftKey,
        drafts: {
          [this.defaultDraftKey]: fallbackDraft,
        },
        revision: 0,
      };
    }
  }

  private hydrateDraft(draft: PersistedNewSessionDraft | undefined): NewSessionDraftState {
    return {
      workingDirectory: this.normalizePath(draft?.workingDirectory),
      prompt: typeof draft?.prompt === 'string' ? draft.prompt : '',
      provider: this.isProviderType(draft?.provider) ? draft.provider : null,
      model: typeof draft?.model === 'string' && draft.model.trim().length > 0 ? draft.model : null,
      nodeId: typeof draft?.nodeId === 'string' && draft.nodeId.trim().length > 0 ? draft.nodeId : null,
      yoloMode: typeof draft?.yoloMode === 'boolean' ? draft.yoloMode : null,
      pendingFolders: Array.isArray(draft?.pendingFolders)
        ? draft.pendingFolders
            .map((entry) => this.normalizePath(entry))
            .filter((entry): entry is string => !!entry)
        : [],
      updatedAt: typeof draft?.updatedAt === 'number' ? draft.updatedAt : Date.now(),
    };
  }

  private patchState(updater: (current: NewSessionDraftStoreState) => NewSessionDraftStoreState): void {
    this.state.update((current) => {
      const next = updater(current);
      if (next === current) {
        return current;
      }

      this.schedulePersist(next);
      return next;
    });
  }

  private updateActiveDraft(
    updater: (draft: NewSessionDraftState) => NewSessionDraftState
  ): void {
    this.patchState((current) => {
      const draft = this.getDraftForState(current, current.activeKey);
      const nextDraft = updater(draft);
      if (nextDraft === draft) {
        return current;
      }

      return {
        ...current,
        drafts: {
          ...current.drafts,
          [current.activeKey]: nextDraft,
        },
        revision: current.revision + 1,
      };
    });
  }

  private getDraftForState(state: NewSessionDraftStoreState, key: string): NewSessionDraftState {
    return this.ensureDraft(state.drafts[key], key === this.defaultDraftKey ? null : state.drafts[key]?.workingDirectory ?? null);
  }

  private getDraftForKey(key: string): NewSessionDraftState {
    return this.getDraftForState(this.state(), key);
  }

  private ensureDraft(
    draft: NewSessionDraftState | undefined,
    workingDirectory: string | null
  ): NewSessionDraftState {
    if (draft) {
      return {
        ...draft,
        workingDirectory: this.normalizePath(workingDirectory ?? draft.workingDirectory),
      };
    }

    return this.createEmptyDraft(workingDirectory);
  }

  private createEmptyDraft(workingDirectory: string | null): NewSessionDraftState {
    return {
      workingDirectory,
      prompt: '',
      provider: null,
      model: null,
      nodeId: null,
      yoloMode: null,
      pendingFolders: [],
      updatedAt: Date.now(),
    };
  }

  private draftHasContent(draft: NewSessionDraftState): boolean {
    return (
      draft.prompt.trim().length > 0 ||
      draft.pendingFolders.length > 0
    );
  }

  private getDraftKey(workingDirectory?: string | null): string {
    const normalized = this.normalizePath(workingDirectory);
    if (!normalized) {
      return this.defaultDraftKey;
    }

    return `project:${this.platformNormalizeKey(normalized)}`;
  }

  private schedulePersist(state: NewSessionDraftStoreState): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
    }

    this.persistHandle = window.setTimeout(() => {
      this.persistHandle = null;
      this.persistState(state);
    }, 200);
  }

  private persistNow(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.persistHandle !== null) {
      window.clearTimeout(this.persistHandle);
      this.persistHandle = null;
    }

    this.persistState(this.state());
  }

  private persistState(state: NewSessionDraftStoreState): void {
    try {
      const payload: PersistedNewSessionDraftStoreState = {
        version: 1,
        activeKey: state.activeKey,
        drafts: state.drafts,
      };
      window.localStorage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Ignore storage errors and keep the in-memory draft available.
    }
  }

  private bumpRevision(): void {
    this.state.update((current) => ({
      ...current,
      revision: current.revision + 1,
    }));
  }

  private normalizePath(path?: string | null): string | null {
    const normalized = path?.trim() ?? '';
    if (!normalized) {
      return null;
    }

    return normalized.replace(/\\/g, '/');
  }

  private platformNormalizeKey(path: string): string {
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
      return path.toLowerCase();
    }

    return path;
  }

  private isProviderType(value: unknown): value is ProviderType {
    return value === 'claude' ||
      value === 'codex' ||
      value === 'gemini' ||
      value === 'copilot' ||
      value === 'auto';
  }
}

interface NewSessionDraftState {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  nodeId: string | null;
  yoloMode: boolean | null; // null = use settings default
  pendingFolders: string[];
  updatedAt: number;
}

interface NewSessionDraftStoreState {
  activeKey: string;
  drafts: Record<string, NewSessionDraftState>;
  revision: number;
}

interface PersistedNewSessionDraft {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  nodeId?: string | null;
  yoloMode?: boolean | null;
  pendingFolders: string[];
  updatedAt: number;
}

interface PersistedNewSessionDraftStoreState {
  version: 1;
  activeKey: string;
  drafts: Record<string, PersistedNewSessionDraft>;
}
