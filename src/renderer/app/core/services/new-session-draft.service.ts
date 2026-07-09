import { Injectable, computed, inject, signal } from '@angular/core';
import {
  getDefaultReasoningEffort,
  getPrimaryModelForProvider,
  normalizeModelForProvider,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
import type { InstanceLaunchMode } from '../../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import { BUILTIN_AGENTS, getDefaultAgent } from '../../../../shared/types/agent.types';
import {
  decodeLocalModelSelector,
  type DecodedLocalModelSelector,
} from '../../../../shared/utils/local-model-selector';
import { ProviderStateService, type ProviderType } from './provider-state.service';
import { WorkspaceIpcService } from './ipc/workspace-ipc.service';
import { ScratchDirectoryService } from './scratch-directory.service';
import { seedProviderModelIntoKnownCatalog } from './provider-model-snapshot-seeding';
import type {
  NewSessionDraftState,
  NewSessionDraftStoreState,
  PersistedNewSessionDraft,
  PersistedNewSessionDraftStoreState,
} from './new-session-draft.types';

@Injectable({ providedIn: 'root' })
export class NewSessionDraftService {
  private readonly providerState = inject(ProviderStateService);
  private readonly workspaceIpc = inject(WorkspaceIpcService);
  private readonly scratchDirectory = inject(ScratchDirectoryService);
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
  readonly modelRuntimeTarget = computed(() => this.activeDraft().modelRuntimeTarget);
  readonly reasoningEffort = computed(() => this.activeDraft().reasoningEffort);
  readonly pendingFolders = computed(() => this.activeDraft().pendingFolders);
  readonly yoloMode = computed(() => this.activeDraft().yoloMode);
  readonly launchMode = computed(() => this.activeDraft().launchMode);
  readonly agentId = computed(() => this.activeDraft().agentId);
  readonly nodeId = computed(() => this.activeDraft().nodeId);
  readonly updatedAt = computed(() => this.activeDraft().updatedAt);
  readonly pendingFiles = computed(() => this.pendingFilesByKey()[this.state().activeKey] ?? []);
  readonly hasActiveContent = computed(() => this.draftHasContent(this.activeDraft()));

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.persistNow());
    }
  }

  open(workingDirectory?: string | null, nodeId?: string | null, options?: { hintWorkspace?: boolean }): void {
    const normalized = this.normalizePath(workingDirectory);
    const draftKey = this.getDraftKey(normalized);
    const draftNodeId = nodeId !== undefined ? nodeId ?? null : this.state().drafts[draftKey]?.nodeId ?? null;
    if (options?.hintWorkspace !== false) {
      this.hintActiveWorkspace(normalized, draftNodeId);
    }
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

    // Best-effort prewarm/index hint. `hintActiveWorkspace` suppresses the
    // general-chat scratch directory so Chats never enter project indexing.
    this.hintActiveWorkspace(normalized, this.state().drafts[nextKey]?.nodeId ?? null);

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
          model: currentDraft.modelRuntimeTarget?.kind === 'local-model'
            ? currentDraft.modelRuntimeTarget.modelId
            : this.normalizeDraftModel(currentDraft.provider, currentDraft.model),
          modelRuntimeTarget: currentDraft.modelRuntimeTarget,
          reasoningEffort: currentDraft.reasoningEffort,
          nodeId: currentDraft.nodeId,
          yoloMode: currentDraft.yoloMode,
          launchMode: currentDraft.launchMode,
          agentId: currentDraft.agentId,
          pendingFolders: [...currentDraft.pendingFolders],
          updatedAt: Date.now(),
        };
        nextDrafts[this.defaultDraftKey] = {
          ...currentDraft,
          prompt: '',
          provider: null,
          model: null,
          modelRuntimeTarget: null,
          reasoningEffort: null,
          nodeId: null,
          yoloMode: null,
          launchMode: null,
          agentId: getDefaultAgent().id,
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
    this.updateActiveDraft((draft) => {
      // Same provider: keep model. Different provider: restore the user's
      // last-used model for that provider (per-provider memory) before
      // falling back to the provider's primary. This makes
      // Copilot+Opus → Claude+Sonnet → Copilot restore Opus instead of
      // resetting to gemini-3.1-pro-preview every time.
      let nextModel: string | null;
      const nextRuntimeTarget = provider === 'auto'
        ? draft.modelRuntimeTarget
        : null;
      if (provider === 'auto' && nextRuntimeTarget?.kind === 'local-model') {
        nextModel = nextRuntimeTarget.modelId;
      } else if (draft.provider === provider) {
        nextModel = this.normalizeDraftModel(provider, draft.model);
      } else if (provider && provider !== 'auto') {
        const remembered = this.providerState.getLastModelForProvider(provider);
        nextModel = this.normalizeDraftModel(provider, remembered ?? null);
      } else {
        nextModel = this.normalizeDraftModel(provider, null);
      }

      const sameProvider = draft.provider === provider;
      // Reasoning is per-provider. On a switch, reset to the new provider's
      // default effort (High for Claude, XHigh for Codex, provider-decided/null
      // otherwise) rather than always clearing.
      const nextReasoning = sameProvider ? draft.reasoningEffort : getDefaultReasoningEffort(provider);
      const nextLaunchMode = this.resolveDraftLaunchMode(provider, sameProvider ? draft.launchMode : null);
      if (
        sameProvider
        && draft.model === nextModel
        && draft.modelRuntimeTarget === nextRuntimeTarget
        && draft.reasoningEffort === nextReasoning
        && draft.launchMode === nextLaunchMode
      ) {
        return draft;
      }

      return {
        ...draft,
        provider,
        model: nextModel,
        modelRuntimeTarget: nextRuntimeTarget,
        reasoningEffort: nextReasoning,
        launchMode: nextLaunchMode,
        updatedAt: Date.now(),
      };
    });
  }

  setModel(model: string | null): void {
    this.updateActiveDraft((draft) => {
      const trimmedLocalModel = typeof model === 'string' ? model.trim() : '';
      const localModelTarget = draft.modelRuntimeTarget?.kind === 'local-model'
        ? draft.modelRuntimeTarget
        : null;
      const nextModel = localModelTarget
        ? (trimmedLocalModel || localModelTarget.modelId)
        : this.normalizeDraftModel(draft.provider, model);
      const nextRuntimeTarget = localModelTarget && nextModel === localModelTarget.modelId
        ? localModelTarget
        : null;
      if (draft.model === nextModel) {
        return draft;
      }

      // Mirror the choice into the global per-provider memory so future
      // session drafts (any working directory) restore this model when
      // the same provider is selected. Use `rememberModelForProvider`
      // rather than `setModel` so we don't overwrite the dashboard's
      // currently-selected provider.
      if (draft.provider && draft.provider !== 'auto' && nextModel) {
        this.providerState.rememberModelForProvider(draft.provider, nextModel);
      }

      return {
        ...draft,
        model: nextModel,
        modelRuntimeTarget: nextRuntimeTarget,
        updatedAt: Date.now(),
      };
    });
  }

  setModelRuntimeTarget(target: ModelRuntimeTarget | null): void {
    this.updateActiveDraft((draft) => {
      if (target?.kind === 'local-model') {
        return {
          ...draft,
          provider: 'auto',
          model: target.modelId,
          modelRuntimeTarget: target,
          nodeId: target.nodeId ?? null,
          reasoningEffort: null,
          launchMode: null,
          updatedAt: Date.now(),
        };
      }

      return {
        ...draft,
        modelRuntimeTarget: target,
        updatedAt: Date.now(),
      };
    });
  }

  setReasoningEffort(reasoningEffort: ReasoningEffort | null): void {
    this.updateActiveDraft((draft) => {
      if (draft.reasoningEffort === reasoningEffort) {
        return draft;
      }
      return {
        ...draft,
        reasoningEffort,
        updatedAt: Date.now(),
      };
    });
  }

  setNodeId(nodeId: string | null): void {
    this.updateActiveDraft((draft) => {
      const localModelTarget = draft.modelRuntimeTarget?.kind === 'local-model'
        ? draft.modelRuntimeTarget
        : null;
      const nextRuntimeTarget =
        localModelTarget
          && (
            (nodeId !== null && localModelTarget.nodeId !== nodeId)
            || (nodeId === null && localModelTarget.nodeId)
          )
          ? null
          : draft.modelRuntimeTarget;
      return {
        ...draft,
        nodeId,
        modelRuntimeTarget: nextRuntimeTarget,
        updatedAt: Date.now(),
      };
    });
  }

  setYoloMode(yoloMode: boolean | null): void {
    this.updateActiveDraft((draft) => ({
      ...draft,
      yoloMode,
      updatedAt: Date.now(),
    }));
  }

  setLaunchMode(launchMode: InstanceLaunchMode | null): void {
    this.updateActiveDraft((draft) => {
      const nextLaunchMode = this.resolveDraftLaunchMode(draft.provider, launchMode);
      if (draft.launchMode === nextLaunchMode) {
        return draft;
      }

      if (draft.provider === 'claude' && nextLaunchMode) {
        this.providerState.rememberLaunchModeForProvider('claude', nextLaunchMode);
      }

      return {
        ...draft,
        launchMode: nextLaunchMode,
        updatedAt: Date.now(),
      };
    });
  }

  setAgentId(agentId: string): void {
    this.updateActiveDraft((draft) => {
      if (draft.agentId === agentId) {
        return draft;
      }
      return {
        ...draft,
        agentId,
        updatedAt: Date.now(),
      };
    });
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
      agentId: getDefaultAgent().id,
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
    const provider = this.isProviderType(draft?.provider) ? draft.provider : null;
    const rawModel = typeof draft?.model === 'string' ? draft.model.trim() : '';
    const persistedModel = rawModel.length > 0 ? rawModel : null;
    const hadPersistedLocalModelTarget = this.isPersistedLocalModelTarget(draft?.modelRuntimeTarget);
    const modelRuntimeTarget = this.hydrateModelRuntimeTarget(draft?.modelRuntimeTarget);
    const persistedNodeId = typeof draft?.nodeId === 'string' && draft.nodeId.trim().length > 0
      ? draft.nodeId.trim()
      : null;
    seedProviderModelIntoKnownCatalog(provider, persistedModel);
    const persistedAgentId = typeof draft?.agentId === 'string' ? draft.agentId.trim() : '';
    const isKnownAgent = persistedAgentId.length > 0
      && BUILTIN_AGENTS.some((a) => a.id === persistedAgentId);
    return {
      workingDirectory: this.normalizePath(draft?.workingDirectory),
      prompt: typeof draft?.prompt === 'string' ? draft.prompt : '',
      provider,
      model: modelRuntimeTarget?.kind === 'local-model'
        ? modelRuntimeTarget.modelId
        : this.normalizeDraftModel(
            provider,
            persistedModel,
          ),
      modelRuntimeTarget,
      reasoningEffort: this.isReasoningEffort(draft?.reasoningEffort) ? draft.reasoningEffort : null,
      nodeId: modelRuntimeTarget?.kind === 'local-model'
        ? modelRuntimeTarget.nodeId ?? null
        : hadPersistedLocalModelTarget ? null : persistedNodeId,
      yoloMode: typeof draft?.yoloMode === 'boolean' ? draft.yoloMode : null,
      launchMode: this.resolveDraftLaunchMode(provider, draft?.launchMode),
      agentId: isKnownAgent ? persistedAgentId : getDefaultAgent().id,
      pendingFolders: Array.isArray(draft?.pendingFolders)
        ? draft.pendingFolders
            .map((entry) => this.normalizePath(entry))
            .filter((entry): entry is string => !!entry)
        : [],
      updatedAt: typeof draft?.updatedAt === 'number' ? draft.updatedAt : Date.now(),
    };
  }

  private hintActiveWorkspace(path: string | null, nodeId: string | null): void {
    if (path) void this.hintActiveWorkspaceAfterScratchInit(path, nodeId);
  }

  private async hintActiveWorkspaceAfterScratchInit(path: string, nodeId: string | null): Promise<void> {
    await this.scratchDirectory.init();
    if (!this.scratchDirectory.isScratch(path)) void this.workspaceIpc.hintActive(path, nodeId);
  }

  private isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
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
      modelRuntimeTarget: null,
      reasoningEffort: null,
      nodeId: null,
      yoloMode: null,
      launchMode: null,
      agentId: getDefaultAgent().id,
      pendingFolders: [],
      updatedAt: Date.now(),
    };
  }

  private normalizeDraftModel(provider: ProviderType | null, model?: string | null): string | null {
    if (!provider || provider === 'auto') {
      return null;
    }

    return normalizeModelForProvider(
      provider,
      model,
      getPrimaryModelForProvider(provider),
    ) ?? null;
  }

  private resolveDraftLaunchMode(
    provider: ProviderType | null,
    launchMode: unknown,
  ): InstanceLaunchMode | null {
    if (provider !== 'claude') {
      return null;
    }
    if (launchMode === 'orchestrated' || launchMode === 'interactive') {
      return launchMode;
    }
    return this.providerState.getLaunchModeForProvider('claude');
  }

  private draftHasContent(draft: NewSessionDraftState): boolean {
    return (
      draft.prompt.trim().length > 0 ||
      draft.modelRuntimeTarget !== null ||
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
      value === 'antigravity' ||
      value === 'copilot' ||
      value === 'cursor' ||
      value === 'grok' ||
      value === 'auto';
  }

  private hydrateModelRuntimeTarget(value: unknown): ModelRuntimeTarget | null {
    if (!this.isRecord(value) || typeof value['kind'] !== 'string') {
      return null;
    }

    if (value['kind'] === 'cli') {
      return {
        kind: 'cli',
        provider: this.isProviderType(value['provider']) ? value['provider'] : undefined,
      };
    }

    if (
      value['kind'] !== 'local-model' ||
      !this.isLocalModelSource(value['source']) ||
      !this.isLocalModelEndpointProvider(value['endpointProvider']) ||
      !this.isNonEmptyString(value['endpointId']) ||
      !this.isNonEmptyString(value['modelId']) ||
      !this.isNonEmptyString(value['selectorId'])
    ) {
      return null;
    }

    const source = value['source'];
    const endpointProvider = value['endpointProvider'];
    const endpointId = value['endpointId'].trim();
    const modelId = value['modelId'].trim();
    const selectorId = value['selectorId'].trim();
    const decodedSelector = this.decodePersistedLocalModelSelector(selectorId);
    if (
      !decodedSelector ||
      decodedSelector.source !== source ||
      decodedSelector.endpointProvider !== endpointProvider ||
      decodedSelector.endpointId !== endpointId ||
      decodedSelector.modelId !== modelId
    ) {
      return null;
    }

    const nodeId = this.isNonEmptyString(value['nodeId']) ? value['nodeId'].trim() : undefined;
    if (source === 'worker-node' && (!nodeId || decodedSelector.nodeId !== nodeId)) {
      return null;
    }
    if (source === 'this-device' && value['nodeId'] !== undefined) {
      return null;
    }

    const nodeName = this.isNonEmptyString(value['nodeName']) ? value['nodeName'].trim() : undefined;
    return {
      kind: 'local-model',
      source,
      endpointProvider,
      endpointId,
      modelId,
      selectorId,
      ...(nodeId ? { nodeId } : {}),
      ...(nodeName ? { nodeName } : {}),
    };
  }

  private decodePersistedLocalModelSelector(selectorId: string): DecodedLocalModelSelector | null {
    try {
      return decodeLocalModelSelector(selectorId);
    } catch {
      return null;
    }
  }

  private isPersistedLocalModelTarget(value: unknown): boolean {
    return this.isRecord(value) && value['kind'] === 'local-model';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  private isLocalModelSource(value: unknown): value is 'this-device' | 'worker-node' {
    return value === 'this-device' || value === 'worker-node';
  }

  private isLocalModelEndpointProvider(
    value: unknown,
  ): value is 'ollama' | 'openai-compatible' {
    return value === 'ollama' || value === 'openai-compatible';
  }
}
