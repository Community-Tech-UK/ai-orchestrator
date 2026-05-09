/**
 * Instance List Store - Manages instance CRUD operations
 *
 * Handles: add, remove, create, terminate, restart, rename instances.
 * Also includes file handling helpers for attachments.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';
import { HistoryStore } from '../history.store';
import { InstanceStateService } from './instance-state.service';
import type {
  Instance,
  InstanceStatus,
  OutputMessage,
  CreateInstanceConfig,
} from './instance.types';
import type { ReasoningEffort } from '../../../../../shared/types/provider.types';
import type { HistoryRestoreMode } from '../../../../../shared/types/history.types';
import { getModelSwitchUnavailableReason } from '../../../../../shared/types/instance-status-policy';

export interface CreateInstanceWithMessageOptions {
  message: string;
  files?: File[];
  workingDirectory?: string;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';
  model?: string;
  forceNodeId?: string;
}

function supportsResumeRestart(provider: Instance['provider']): boolean {
  return provider === 'claude' || provider === 'codex';
}

@Injectable({ providedIn: 'root' })
export class InstanceListStore {
  private stateService = inject(InstanceStateService);
  private ipc = inject(ElectronIpcService);
  private historyStore = inject(HistoryStore);

  private static readonly CREATE_INSTANCE_EVENT_FALLBACK_TIMEOUT_MS = 10_000;
  private static readonly CREATE_INSTANCE_EVENT_POLL_MS = 50;

  // File size limits (Anthropic API limits)
  private static readonly MAX_IMAGE_SIZE = 5 * 1024 * 1024;     // 5MB for images
  private static readonly MAX_FILE_SIZE = 30 * 1024 * 1024;      // 30MB for other files
  private static readonly MAX_IMAGE_DIMENSION = 2000;            // Claude API max for multi-image requests

  // ============================================
  // Instance CRUD Operations
  // ============================================

  /**
   * Add an instance to the store (called from IPC listener)
   */
  addInstance(data: unknown): void {
    const instance = this.deserializeInstance(data);

    // Passive backend events must not steal focus from a user's current session.
    // Explicit create/restore flows select their returned instance themselves.
    const shouldAutoSelect =
      !instance.parentId
      && !this.stateService.state().selectedInstanceId
      && !this.historyStore.previewEntryId();

    this.stateService.addInstance(instance, shouldAutoSelect);
  }

  /**
   * Remove an instance from the store (called from IPC listener)
   */
  removeInstance(instanceId: string): void {
    this.stateService.removeInstance(instanceId);
  }

  /**
   * Load initial instances from the backend
   */
  async loadInitialInstances(): Promise<void> {
    this.stateService.setLoading(true);

    try {
      const response = (await this.ipc.listInstances()) as {
        success: boolean;
        data?: unknown[];
      };
      if (response.success && response.data && Array.isArray(response.data)) {
        const instances = new Map<string, Instance>();
        for (const data of response.data) {
          const item = data as Record<string, unknown>;
          instances.set(item['id'] as string, this.deserializeInstance(item));
        }
        this.stateService.setInstances(instances);
      }
    } catch (err) {
      console.error('Failed to load instances:', err);
      this.stateService.setLoading(false);
      this.stateService.setError('Failed to load instances');
    }
  }

  /**
   * Create a new instance
   */
  async createInstance(config: CreateInstanceConfig): Promise<void> {
    await this.createInstanceAndReturnId(config);
  }

  /**
   * Create a new instance, returning the new instance ID.
   */
  async createInstanceAndReturnId(config: CreateInstanceConfig): Promise<string | null> {
    console.log('InstanceListStore: createInstance called with:', config);
    this.stateService.setLoading(true);
    const beforeIds = new Set(this.stateService.state().instances.keys());
    const eventFallback = this.watchCreatedInstanceFromState(beforeIds, config);

    try {
      const payload = {
        workingDirectory: config.workingDirectory || '.',
        displayName: config.displayName,
        parentInstanceId: config.parentId,
        yoloMode: config.yoloMode,
        agentId: config.agentId,
        provider: config.provider,
        model: config.model,
        forceNodeId: config.forceNodeId,
      };
      const result = await Promise.race([
        this.ipc.createInstance(payload).then((response) => ({
          kind: 'response' as const,
          response,
        })),
        eventFallback.promise.then((instanceId) => ({
          kind: 'event' as const,
          instanceId,
        })),
      ]);
      eventFallback.cancel();

      if (result.kind === 'event') {
        this.stateService.setLoading(false);
        if (result.instanceId) {
          this.stateService.setSelectedInstance(result.instanceId);
          return result.instanceId;
        }
        this.stateService.setError('Failed to create instance');
        return null;
      }

      const response = result.response;
      console.log('InstanceListStore: createInstance result:', response);
      this.stateService.setLoading(false);
      if (response.success) {
        return this.syncInstanceFromResponse(response.data, true);
      } else {
        this.stateService.setError(response.error?.message || 'Failed to create instance');
      }
      return null;
    } catch (error) {
      eventFallback.cancel();
      console.error('InstanceListStore: createInstance error:', error);
      this.stateService.setLoading(false);
      this.stateService.setError('Failed to create instance');
      return null;
    }
  }

  /**
   * Create instance and immediately send a message
   */
  async createInstanceWithMessage(
    options: CreateInstanceWithMessageOptions,
  ): Promise<boolean> {
    return (await this.createInstanceWithMessageAndReturnId(options)) !== null;
  }

  /**
   * Create instance and immediately send a message, returning the new instance ID.
   */
  async createInstanceWithMessageAndReturnId(
    options: CreateInstanceWithMessageOptions,
  ): Promise<string | null> {
    const { message, files, workingDirectory, agentId, provider, model, forceNodeId } = options;

    console.log('InstanceListStore: createInstanceWithMessage called with:', {
      message,
      filesCount: files?.length,
      workingDirectory,
      agentId,
      provider,
      model,
    });

    if (files && files.length > 0) {
      const validationErrors = this.validateFiles(files);
      if (validationErrors.length > 0) {
        const errorMessage = validationErrors.join('\n');
        console.error('InstanceListStore: File validation failed:', errorMessage);
        this.stateService.setError(`Cannot create instance:\n${errorMessage}`);
        return null;
      }
    }

    this.stateService.setLoading(true);

    try {
      const attachments =
        files && files.length > 0
          ? (await Promise.all(files.map((f) => this.fileToAttachments(f)))).flat()
          : undefined;

      const result = await this.ipc.createInstanceWithMessage({
        workingDirectory: workingDirectory || '.',
        message,
        attachments,
        agentId,
        provider: provider === 'auto' ? undefined : provider,
        model,
        forceNodeId,
      });
      console.log('InstanceListStore: createInstanceWithMessage result:', result);
      this.stateService.setLoading(false);
      if (!result.success) {
        this.stateService.setError(result.error?.message || 'Failed to create instance');
      } else {
        return this.syncInstanceFromResponse(result.data, true);
      }
      return null;
    } catch (error) {
      console.error('InstanceListStore: createInstanceWithMessage error:', error);
      this.stateService.setLoading(false);
      this.stateService.setError(`Failed to create instance: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Create a child instance
   */
  async createChildInstance(parentId: string): Promise<void> {
    const parent = this.stateService.getInstance(parentId);
    if (!parent) return;

    await this.createInstance({
      workingDirectory: parent.workingDirectory,
      displayName: `${parent.displayName} > Child`,
      parentId,
    });
  }

  /**
   * Terminate an instance
   */
  async terminateInstance(instanceId: string, graceful = true): Promise<void> {
    await this.ipc.terminateInstance(instanceId, graceful);
  }

  /**
   * Interrupt an instance (Ctrl+C equivalent)
   *
   * NOTE: We intentionally do NOT set an optimistic status here.
   * The main process sets status to 'respawning' and then 'idle' once
   * the new CLI process is ready. Setting an optimistic 'waiting_for_input'
   * would trigger processMessageQueue prematurely, causing sendInput to
   * fail because the main process rejects messages during respawning.
   *
   * @returns true if the interrupt was accepted by the backend, false otherwise
   */
  async interruptInstance(instanceId: string): Promise<boolean> {
    const result = await this.ipc.interruptInstance(instanceId);
    const data = result.data as { interrupted?: boolean } | undefined;
    return result.success && data?.interrupted === true;
  }

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (instance && !supportsResumeRestart(instance.provider)) {
      await this.ipc.restartFreshInstance(instanceId);
      return;
    }
    await this.ipc.restartInstance(instanceId);
  }

  /**
   * Restart an instance with fresh context
   */
  async restartFreshInstance(instanceId: string): Promise<void> {
    await this.ipc.restartFreshInstance(instanceId);
  }

  /**
   * Rename an instance
   */
  async renameInstance(instanceId: string, displayName: string): Promise<void> {
    // Optimistic update
    this.stateService.updateInstance(instanceId, { displayName, isRenamed: true });
    await this.ipc.renameInstance(instanceId, displayName);
  }

  /**
   * Terminate all instances
   */
  async terminateAllInstances(): Promise<void> {
    await this.ipc.terminateAllInstances();
  }

  /**
   * Toggle YOLO mode for an instance
   */
  async toggleYoloMode(instanceId: string): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    console.log('[InstanceListStore] toggleYoloMode called for:', instanceId);

    const response = await this.ipc.toggleYoloMode(instanceId);
    console.log('[InstanceListStore] toggleYoloMode response:', response);

    if (response.success && 'data' in response) {
      const data = response.data as { yoloMode?: boolean; status?: string } | undefined;
      const newYoloMode = data?.yoloMode ?? !instance.yoloMode;
      console.log('[InstanceListStore] Updating yoloMode to', newYoloMode);

      this.stateService.updateInstance(instanceId, {
        yoloMode: newYoloMode,
        status: (data?.status as InstanceStatus) || 'idle',
      });
    } else if ('error' in response) {
      console.error('Failed to toggle YOLO mode:', response.error);
    }
  }

  /**
   * Change agent mode for an instance
   */
  async changeAgentMode(instanceId: string, newAgentId: string): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance || instance.agentId === newAgentId) return;

    const response = await this.ipc.changeAgentMode(instanceId, newAgentId);

    if (response.success && 'data' in response && response.data) {
      const data = response.data as { agentMode?: string; status?: string };
      this.stateService.updateInstance(instanceId, {
        agentId: newAgentId,
        agentMode: (data.agentMode as 'build' | 'plan' | 'review') || instance.agentMode,
        status: (data.status as InstanceStatus) || 'idle',
      });
    } else if ('error' in response) {
      console.error('Failed to change agent mode:', response.error);
    }
  }

  /**
   * Change model for an instance
   */
  async changeModel(
    instanceId: string,
    newModel: string,
    reasoningEffort?: ReasoningEffort | null
  ): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    const nextReasoningEffort =
      reasoningEffort === undefined
        ? instance.reasoningEffort
        : reasoningEffort ?? undefined;
    if (
      instance.currentModel === newModel &&
      instance.reasoningEffort === nextReasoningEffort
    ) {
      return;
    }

    const unavailableReason = getModelSwitchUnavailableReason(instance.status);
    if (unavailableReason) {
      this.stateService.setError(unavailableReason);
      return;
    }

    const response = await this.ipc.changeModel(instanceId, newModel, reasoningEffort);

    if (response.success && 'data' in response && response.data) {
      const data = response.data as {
        currentModel?: string;
        reasoningEffort?: ReasoningEffort | null;
        status?: string;
      };
      this.stateService.updateInstance(instanceId, {
        currentModel: data.currentModel || newModel,
        reasoningEffort: data.reasoningEffort ?? nextReasoningEffort,
        status: (data.status as InstanceStatus) || 'idle',
      });
    } else if ('error' in response) {
      console.error('Failed to change model:', response.error);
    }
  }

  /**
   * Open folder picker and change working directory for an instance
   */
  async selectWorkingDirectory(instanceId: string): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance) return;

    const folder = await this.ipc.selectFolder();
    if (!folder) return; // User cancelled

    const { displayName, parentId, yoloMode } = instance;
    await this.terminateInstance(instanceId);

    await this.createInstance({
      workingDirectory: folder,
      displayName,
      parentId: parentId || undefined,
      yoloMode,
    });
  }

  /**
   * Set working directory for an instance (terminates and recreates)
   * Similar to selectWorkingDirectory but accepts a path directly
   */
  async setWorkingDirectory(instanceId: string, folder: string): Promise<void> {
    const instance = this.stateService.getInstance(instanceId);
    if (!instance || !folder) return;

    const { displayName, parentId, yoloMode } = instance;
    await this.terminateInstance(instanceId);

    await this.createInstance({
      workingDirectory: folder,
      displayName,
      parentId: parentId || undefined,
      yoloMode,
    });
  }

  /**
   * Set output messages for an instance (used for restoring history)
   */
  setInstanceMessages(instanceId: string, messages: OutputMessage[]): void {
    this.stateService.updateInstance(instanceId, {
      outputBuffer: messages,
    });
  }

  /**
   * Set the restore mode for an instance (called after history restore)
   */
  setInstanceRestoreMode(instanceId: string, restoreMode: HistoryRestoreMode): void {
    this.stateService.updateInstance(instanceId, { restoreMode });
  }

  /**
   * Clear the restore mode for an instance
   */
  clearInstanceRestoreMode(instanceId: string): void {
    this.stateService.updateInstance(instanceId, { restoreMode: undefined });
  }

  // ============================================
  // Helpers
  // ============================================

  private syncInstanceFromResponse(data: unknown, selectRoot: boolean): string | null {
    if (!data || typeof data !== 'object') {
      return null;
    }

    const id = (data as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0) {
      return null;
    }

    const instance = this.deserializeInstance(data);
    this.stateService.addInstance(instance, false);

    if (selectRoot && !instance.parentId) {
      this.stateService.setSelectedInstance(instance.id);
    }

    return instance.id;
  }

  private watchCreatedInstanceFromState(
    beforeIds: Set<string>,
    config: CreateInstanceConfig,
  ): { promise: Promise<string | null>; cancel: () => void } {
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settle: (value: string | null) => void = () => undefined;
    let settled = false;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (interval) clearInterval(interval);
      if (timeout) clearTimeout(timeout);
      settle(value);
    };

    const promise = new Promise<string | null>((resolve) => {
      settle = resolve;
      interval = setInterval(() => {
        const instanceId = this.findCreatedInstanceFromState(beforeIds, config);
        if (instanceId) {
          finish(instanceId);
        }
      }, InstanceListStore.CREATE_INSTANCE_EVENT_POLL_MS);
      timeout = setTimeout(
        () => finish(null),
        InstanceListStore.CREATE_INSTANCE_EVENT_FALLBACK_TIMEOUT_MS,
      );
    });

    return {
      promise,
      cancel: () => finish(null),
    };
  }

  private findCreatedInstanceFromState(
    beforeIds: Set<string>,
    config: CreateInstanceConfig,
  ): string | null {
    const expectedWorkingDirectory = config.workingDirectory
      ? this.normalizePathForComparison(config.workingDirectory)
      : null;
    const expectedParentId = config.parentId ?? null;

    for (const instance of this.stateService.state().instances.values()) {
      if (beforeIds.has(instance.id)) continue;
      if ((instance.parentId ?? null) !== expectedParentId) continue;
      if (
        expectedWorkingDirectory
        && this.normalizePathForComparison(instance.workingDirectory) !== expectedWorkingDirectory
      ) {
        continue;
      }
      return instance.id;
    }

    return null;
  }

  private normalizePathForComparison(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  }

  /**
   * Deserialize instance data from IPC
   */
  deserializeInstance(data: unknown): Instance {
    const d = data as Record<string, unknown>;
    const currentModel =
      typeof d['currentModel'] === 'string' ? d['currentModel'] : undefined;
    const reasoningEffort = this.isReasoningEffort(d['reasoningEffort'])
      ? d['reasoningEffort']
      : undefined;

    return {
      id: d['id'] as string,
      displayName: d['displayName'] as string,
      createdAt: d['createdAt'] as number,
      historyThreadId: (d['historyThreadId'] as string) || (d['sessionId'] as string),
      parentId: d['parentId'] as string | null,
      childrenIds: (d['childrenIds'] as string[]) || [],
      agentId: (d['agentId'] as string) || 'build',
      agentMode: (d['agentMode'] as 'build' | 'plan' | 'review') || 'build',
      // Older restores and some legacy payloads can arrive without provider.
      // Recover it from model/session identifiers instead of silently
      // repainting Gemini/Codex threads as Claude.
      provider: this.inferInstanceProvider(d),
      status: d['status'] as InstanceStatus,
      contextUsage: (d['contextUsage'] as Instance['contextUsage']) || {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: d['lastActivity'] as number,
      activityState:
        typeof d['activityState'] === 'string'
          ? (d['activityState'] as Instance['activityState'])
          : undefined,
      currentActivity:
        typeof d['currentActivity'] === 'string'
          ? d['currentActivity']
          : undefined,
      currentTool:
        typeof d['currentTool'] === 'string' ? d['currentTool'] : undefined,
      providerSessionId:
        typeof d['providerSessionId'] === 'string'
          ? d['providerSessionId']
          : (d['sessionId'] as string),
      sessionId: d['sessionId'] as string,
      restartEpoch:
        typeof d['restartEpoch'] === 'number' ? d['restartEpoch'] : 0,
      adapterGeneration:
        typeof d['adapterGeneration'] === 'number' ? d['adapterGeneration'] : 0,
      activeTurnId:
        typeof d['activeTurnId'] === 'string' ? d['activeTurnId'] : undefined,
      interruptRequestId:
        typeof d['interruptRequestId'] === 'string' ? d['interruptRequestId'] : undefined,
      interruptRequestedAt:
        typeof d['interruptRequestedAt'] === 'number' ? d['interruptRequestedAt'] : undefined,
      interruptPhase:
        typeof d['interruptPhase'] === 'string'
          ? (d['interruptPhase'] as Instance['interruptPhase'])
          : undefined,
      lastTurnOutcome:
        typeof d['lastTurnOutcome'] === 'string'
          ? (d['lastTurnOutcome'] as Instance['lastTurnOutcome'])
          : undefined,
      supersededBy:
        typeof d['supersededBy'] === 'string' ? d['supersededBy'] : undefined,
      cancelledForEdit:
        typeof d['cancelledForEdit'] === 'boolean' ? d['cancelledForEdit'] : undefined,
      recoveryMethod:
        typeof d['recoveryMethod'] === 'string'
          ? (d['recoveryMethod'] as Instance['recoveryMethod'])
          : undefined,
      archivedUpToMessageId:
        typeof d['archivedUpToMessageId'] === 'string'
          ? d['archivedUpToMessageId']
          : undefined,
      workingDirectory: d['workingDirectory'] as string,
      yoloMode: (d['yoloMode'] as boolean) ?? false,
      currentModel,
      reasoningEffort,
      outputBuffer: (d['outputBuffer'] as OutputMessage[]) || [],
      restoreMode: d['restoreMode'] as HistoryRestoreMode | undefined,
      diffStats: d['diffStats'] as Instance['diffStats'] | undefined,
      hasUnreadCompletion: false,
      pendingApprovalCount: 0,
      metadata: this.isRecord(d['metadata']) ? d['metadata'] : undefined,
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private inferInstanceProvider(data: Record<string, unknown>): Instance['provider'] {
    const explicitProvider = data['provider'];
    if (this.isInstanceProvider(explicitProvider)) {
      return explicitProvider;
    }

    return (
      this.inferProviderFromModel(data['currentModel'])
      || this.inferProviderFromIdentifier(data['historyThreadId'])
      || this.inferProviderFromIdentifier(data['sessionId'])
      || this.inferProviderFromIdentifier(data['id'])
      || 'claude'
    );
  }

  private inferProviderFromModel(model: unknown): Instance['provider'] | undefined {
    if (typeof model !== 'string') {
      return undefined;
    }

    const normalized = model.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (normalized.startsWith('gemini')) return 'gemini';
    if (normalized.startsWith('copilot')) return 'copilot';
    if (
      normalized.startsWith('gpt-')
      || normalized.includes('codex')
      || normalized === 'o3'
    ) {
      return 'codex';
    }
    if (
      normalized.startsWith('claude')
      || normalized === 'opus'
      || normalized === 'sonnet'
      || normalized === 'haiku'
    ) {
      return 'claude';
    }

    return undefined;
  }

  private inferProviderFromIdentifier(value: unknown): Instance['provider'] | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }

    if (normalized.startsWith('gemini-')) return 'gemini';
    if (normalized.startsWith('codex-')) return 'codex';
    if (normalized.startsWith('copilot-')) return 'copilot';
    if (normalized.startsWith('claude-')) return 'claude';
    if (normalized.startsWith('u-')) return 'cursor';

    return undefined;
  }

  private isInstanceProvider(value: unknown): value is Instance['provider'] {
    return value === 'claude'
      || value === 'codex'
      || value === 'gemini'
      || value === 'copilot'
      || value === 'ollama'
      || value === 'cursor';
  }

  private isReasoningEffort(value: unknown): value is ReasoningEffort {
    return value === 'none'
      || value === 'minimal'
      || value === 'low'
      || value === 'medium'
      || value === 'high'
      || value === 'xhigh';
  }

  /**
   * Validate files before sending - returns array of error messages
   */
  validateFiles(files: File[]): string[] {
    const errors: string[] = [];
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const maxSize = isImage ? InstanceListStore.MAX_IMAGE_SIZE : InstanceListStore.MAX_FILE_SIZE;
      const maxSizeMB = isImage ? 5 : 30;

      // Images will be auto-compressed, so only show error if non-image is too large
      if (!isImage && file.size > maxSize) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        errors.push(`${file.name} is too large (${sizeMB}MB). Maximum size is ${maxSizeMB}MB.`);
      }
    }
    return errors;
  }

  /**
   * Convert a File to one or more attachment objects for IPC.
   * Oversized images are tiled into ≤2000px chunks to stay within
   * the Claude API's multi-image dimension limit.
   */
  async fileToAttachments(file: File): Promise<{
    name: string;
    type: string;
    size: number;
    data: string;
  }[]> {
    const isImage = file.type.startsWith('image/');

    // Non-image files: return single attachment
    if (!isImage) {
      if (file.size > InstanceListStore.MAX_FILE_SIZE) {
        throw new Error(`File ${file.name} exceeds maximum size of 30MB`);
      }
      const data = await this.fileToDataURL(file);
      return [{ name: file.name, type: file.type, size: file.size, data }];
    }

    // Image: check if tiling is needed
    const dimensions = await this.getImageDimensions(file);
    const maxDim = InstanceListStore.MAX_IMAGE_DIMENSION;

    if (dimensions.width > maxDim || dimensions.height > maxDim) {
      // Tile the image into ≤2000px chunks
      return this.tileOversizedImage(file, dimensions);
    }

    // Small image: compress if over size limit, then return single attachment
    let processedFile = file;
    if (file.size > InstanceListStore.MAX_IMAGE_SIZE) {
      processedFile = await this.tryCompressImage(file);
    }

    if (processedFile.size > InstanceListStore.MAX_IMAGE_SIZE) {
      throw new Error(`File ${file.name} exceeds maximum size of 5MB`);
    }

    const data = await this.fileToDataURL(processedFile);
    return [{ name: processedFile.name, type: processedFile.type, size: processedFile.size, data }];
  }

  /**
   * Try to compress an image to fit within the 5MB limit
   */
  private async tryCompressImage(file: File): Promise<File> {
    const qualities = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];

    for (const quality of qualities) {
      const compressed = await this.compressImage(file, quality);
      if (compressed && compressed.size <= InstanceListStore.MAX_IMAGE_SIZE) {
        const newFileName = file.name.replace(/\.[^.]+$/, '.webp');
        return new File([compressed], newFileName, { type: 'image/webp' });
      }
    }

    // If still too large, return original and let it fail with error
    return file;
  }

  /**
   * Compress an image to WebP format at the specified quality
   */
  private async compressImage(file: File, quality = 0.85): Promise<Blob | null> {
    return new Promise((resolve) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;

          // Downscale if image exceeds maximum dimension
          const maxDim = InstanceListStore.MAX_IMAGE_DIMENSION;
          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.floor(width * ratio);
            height = Math.floor(height * ratio);
          }

          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(null);
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            (blob) => {
              resolve(blob);
            },
            'image/webp',
            quality
          );
        };

        img.onerror = () => resolve(null);
        img.src = e.target?.result as string;
      };

      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Read a File as a data URL string
   */
  private fileToDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Get the pixel dimensions of an image File
   */
  private getImageDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load image ${file.name}`));
      };
      img.src = url;
    });
  }

  /**
   * Tile an oversized image into ≤2000px chunks.
   * Width is scaled down to 2000 if needed; height is split into vertical tiles.
   * Each tile is labeled (e.g. "screenshot_tile1of3.webp") so the model can
   * reassemble them top-to-bottom.
   */
  private async tileOversizedImage(
    file: File,
    dimensions: { width: number; height: number }
  ): Promise<{ name: string; type: string; size: number; data: string }[]> {
    const maxDim = InstanceListStore.MAX_IMAGE_DIMENSION;
    const img = await this.loadImage(file);

    // Scale width to ≤2000, preserving aspect ratio
    let drawWidth = dimensions.width;
    let drawHeight = dimensions.height;
    if (drawWidth > maxDim) {
      const ratio = maxDim / drawWidth;
      drawWidth = maxDim;
      drawHeight = Math.floor(dimensions.height * ratio);
    }

    const tileHeight = maxDim;
    const tileCount = Math.ceil(drawHeight / tileHeight);
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const attachments: { name: string; type: string; size: number; data: string }[] = [];

    for (let i = 0; i < tileCount; i++) {
      const srcY = Math.floor((i * tileHeight / drawHeight) * dimensions.height);
      const nextY = Math.floor(((i + 1) * tileHeight / drawHeight) * dimensions.height);
      const srcH = Math.min(nextY, dimensions.height) - srcY;

      const destH = Math.min(tileHeight, drawHeight - i * tileHeight);
      const canvas = document.createElement('canvas');
      canvas.width = drawWidth;
      canvas.height = destH;

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      ctx.drawImage(img, 0, srcY, dimensions.width, srcH, 0, 0, drawWidth, destH);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/webp', 0.92)
      );
      if (!blob) continue;

      const tileName = `${baseName}_tile${i + 1}of${tileCount}.webp`;
      const tileFile = new File([blob], tileName, { type: 'image/webp' });
      const data = await this.fileToDataURL(tileFile);
      attachments.push({ name: tileName, type: 'image/webp', size: tileFile.size, data });
    }

    return attachments;
  }

  /**
   * Load a File into an HTMLImageElement
   */
  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load image ${file.name}`));
      };
      img.src = url;
    });
  }
}
