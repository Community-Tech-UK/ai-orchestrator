/**
 * Instance IPC Service - Instance lifecycle and management
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  FileAttachment,
  InstanceLaunchMode,
} from '../../../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../../../shared/types/local-model-runtime.types';
import type { ReasoningEffort } from '../../../../../shared/types/provider.types';

export interface CreateInstanceConfig {
  workingDirectory: string;
  displayName?: string;
  parentInstanceId?: string;
  initialPrompt?: string;
  yoloMode?: boolean;
  launchMode?: InstanceLaunchMode;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'auto';
  model?: string;
  modelRuntimeTarget?: ModelRuntimeTarget;
  bareMode?: boolean;
  fastMode?: boolean;
  forceNodeId?: string;
  /** WS9 per-instance browser tool surface; omitted = global setting decides. */
  browserToolsMode?: 'eager' | 'deferred' | 'off';
  /** WS13 — spawn the CLI inside the macOS Seatbelt jail. */
  hardened?: boolean;
}

export interface CreateInstanceWithMessageConfig {
  workingDirectory: string;
  message: string;
  attachments?: FileAttachment[];
  launchMode?: InstanceLaunchMode;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'auto';
  model?: string;
  modelRuntimeTarget?: ModelRuntimeTarget;
  yoloMode?: boolean;
  bareMode?: boolean;
  fastMode?: boolean;
  forceNodeId?: string;
  /** WS13 — spawn the CLI inside the macOS Seatbelt jail. */
  hardened?: boolean;
}

export interface PersistedQueuedMessage {
  message: string;
  hadAttachmentsDropped: boolean;
  retryCount?: number;
  seededAlready?: boolean;
  kind?: 'queue' | 'steer';
}

export interface InstanceQueueInitialPromptPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
  seededAlready: true;
}

@Injectable({ providedIn: 'root' })
export class InstanceIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Instance Lifecycle
  // ============================================

  /**
   * Create a new instance
   */
  async createInstance(config: CreateInstanceConfig): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createInstance(config);
  }

  /**
   * Create a new instance and immediately send a message
   */
  async createInstanceWithMessage(config: CreateInstanceWithMessageConfig): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createInstanceWithMessage(config);
  }

  /**
   * Send input to an instance
   */
  async sendInput(instanceId: string, message: string, attachments?: FileAttachment[], isRetry?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.sendInput({ instanceId, message, attachments, isRetry });
  }

  async steerInput(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<IpcResponse> {
    if (!this.api?.steerInput) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.steerInput({ instanceId, message, attachments });
  }

  async instanceQueueSave(instanceId: string, queue: PersistedQueuedMessage[]): Promise<IpcResponse> {
    if (!this.api?.instanceQueueSave) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.instanceQueueSave({ instanceId, queue });
  }

  async instanceQueueLoadAll(): Promise<IpcResponse<{ queues: Record<string, PersistedQueuedMessage[]> }>> {
    if (!this.api?.instanceQueueLoadAll) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.instanceQueueLoadAll() as Promise<
      IpcResponse<{ queues: Record<string, PersistedQueuedMessage[]> }>
    >;
  }

  onInstanceQueueInitialPrompt(callback: (payload: InstanceQueueInitialPromptPayload) => void): () => void {
    if (!this.api?.onInstanceQueueInitialPrompt) return () => { /* noop */ };
    return this.api.onInstanceQueueInitialPrompt((payload) => {
      this.ngZone.run(() => callback(payload as InstanceQueueInitialPromptPayload));
    });
  }

  /**
   * Terminate an instance
   */
  async terminateInstance(instanceId: string, graceful = true): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.terminateInstance({ instanceId, graceful });
  }

  /**
   * Interrupt an instance (Ctrl+C equivalent)
   * Sends SIGINT to pause current operation without terminating
   */
  async interruptInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.interruptInstance({ instanceId });
  }

  /**
   * Resume a session parked on a provider limit immediately (skip the wait).
   */
  async providerLimitResumeNow(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.providerLimitResumeNow({ instanceId });
  }

  /**
   * Cancel a provider-limit park so the session will not auto-resume.
   */
  async providerLimitCancel(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.providerLimitCancel({ instanceId });
  }

  /**
   * Re-probe provider auth for a session the provider signed out. Resumes the
   * interrupted turn when the user has signed back in.
   */
  async authRepairRetry(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.authRepairRetry({ instanceId });
  }

  /** Dismiss the signed-out banner and stop watching for a sign-in. */
  async authRepairCancel(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.authRepairCancel({ instanceId });
  }

  /** WS7 Phase B — switch a parked session to its next fallback provider now. */
  async instanceFailoverNow(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.instanceFailoverNow({ instanceId });
  }

  /** WS13 slice 3 — grant a Seatbelt writable root and restart into the rebuilt jail. */
  async hardenedAllowPath(instanceId: string, path: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.hardenedAllowPath({ instanceId, path });
  }

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.restartInstance({ instanceId });
  }

  /**
   * Restart an instance with fresh context
   */
  async restartFreshInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.restartFreshInstance({ instanceId });
  }

  /**
   * Rename an instance
   */
  async renameInstance(instanceId: string, displayName: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.renameInstance({ instanceId, displayName });
  }

  /**
   * Change agent mode for an instance (preserves conversation context)
   */
  async changeAgentMode(instanceId: string, agentId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.changeAgentMode({ instanceId, agentId });
  }

  /**
   * Toggle YOLO mode for an instance (preserves conversation context)
   */
  async toggleYoloMode(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.toggleYoloMode({ instanceId });
  }

  /**
   * Toggle or set fast mode for an instance (preserves conversation context).
   * Omit `fastMode` to flip the current value.
   */
  async toggleFastMode(instanceId: string, fastMode?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.toggleFastMode({ instanceId, fastMode });
  }

  /**
   * Change model and/or provider for an instance (preserves conversation
   * context). `model` may be omitted when `provider` is set — the backend
   * falls back to the remembered per-provider default. Requests made while
   * the instance is busy are queued and applied on the next idle.
   */
  async changeModel(
    instanceId: string,
    model: string | undefined,
    reasoningEffort?: ReasoningEffort | null,
    modelRuntimeTarget?: ModelRuntimeTarget,
    provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok',
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.changeModel({
      instanceId,
      ...(model !== undefined ? { model } : {}),
      reasoningEffort,
      ...(modelRuntimeTarget ? { modelRuntimeTarget } : {}),
      ...(provider ? { provider } : {}),
    });
  }

  /**
   * Terminate all instances
   */
  async terminateAllInstances(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.terminateAllInstances();
  }

  /**
   * Get all instances
   */
  async listInstances(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listInstances();
  }

  // ============================================
  // Event Subscriptions
  // ============================================

  /**
   * Subscribe to instance created events
   */
  onInstanceCreated(callback: (instance: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onInstanceCreated((instance) => {
      this.ngZone.run(() => callback(instance));
    });
  }

  /**
   * Subscribe to instance removed events
   */
  onInstanceRemoved(callback: (instanceId: string) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onInstanceRemoved((instanceId) => {
      this.ngZone.run(() => callback(instanceId));
    });
  }

  /**
   * Subscribe to instance state updates
   */
  onInstanceStateUpdate(callback: (update: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onInstanceStateUpdate((update) => {
      this.ngZone.run(() => callback(update));
    });
  }

  /**
   * Subscribe to YOLO changes pushed from main: an applied toggle, or a change
   * queued/cancelled while the instance was busy (`pendingYoloMode`).
   */
  onYoloToggled(
    callback: (payload: { instanceId: string; yoloMode: boolean; pendingYoloMode?: boolean }) => void,
  ): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onYoloToggled((payload) => {
      this.ngZone.run(() => callback(payload));
    });
  }

  /**
   * Subscribe to fast-mode changes pushed from main (user toggle + auto-revert)
   */
  onFastToggled(
    callback: (payload: { instanceId: string; fastMode: boolean; reason: 'user' | 'unavailable' }) => void,
  ): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onFastToggled((payload) => {
      this.ngZone.run(() => callback(payload));
    });
  }

  /**
   * Subscribe to batch updates
   */
  onBatchUpdate(callback: (batch: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onBatchUpdate((batch) => {
      this.ngZone.run(() => callback(batch));
    });
  }

  // ============================================
  // User Action Requests
  // ============================================

  /**
   * Subscribe to user action requests from the orchestrator
   */
  onUserActionRequest(callback: (request: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onUserActionRequest((request) => {
      this.ngZone.run(() => callback(request));
    });
  }

  /**
   * Respond to a user action request
   */
  async respondToUserAction(
    requestId: string,
    approved: boolean,
    selectedOption?: string
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.respondToUserAction(requestId, approved, selectedOption);
  }

  /**
   * List all pending user action requests
   */
  async listUserActionRequests(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listUserActionRequests();
  }

  /**
   * List pending user action requests for a specific instance
   */
  async listUserActionRequestsForInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listUserActionRequestsForInstance(instanceId);
  }

  // ============================================
  // Output History
  // ============================================

  /**
   * Load older messages from disk storage for an instance
   */
  async loadOlderMessages(
    instanceId: string,
    options?: { beforeChunk?: number; limit?: number }
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.loadOlderMessages({ instanceId, ...options });
  }

  /**
   * Full user-prompt index for a session (stored tally + main-process buffer).
   */
  async getPromptIndex(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getPromptIndex({ instanceId });
  }

  // ============================================
  // Context Compaction
  // ============================================

  /**
   * Compact context for an instance (manual trigger)
   */
  async compactInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.compactInstance({ instanceId });
  }

  async recoverCompactionContext(
    instanceId: string,
    markerId: string,
  ): Promise<IpcResponse<{ markerId: string; queuedForNextTurn: true; segmentsIncluded: number; contextChars: number }>> {
    if (!this.api?.recoverCompactionContext) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.recoverCompactionContext({ instanceId, markerId }) as Promise<
      IpcResponse<{ markerId: string; queuedForNextTurn: true; segmentsIncluded: number; contextChars: number }>
    >;
  }

  /**
   * Subscribe to compaction status updates
   */
  onCompactStatus(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCompactStatus((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to context warning events
   */
  onContextWarning(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onContextWarning((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to orchestration activity updates (child spawn, debate, verification progress)
   */
  onOrchestrationActivity(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onOrchestrationActivity((data: unknown) => {
      this.ngZone.run(() => callback(data));
    });
  }

  // ============================================
  // Input Required (CLI Permission Prompts)
  // ============================================

  /**
   * Subscribe to input required events (permission prompts from CLI)
   */
  onInputRequired(callback: (payload: {
    instanceId: string;
    requestId: string;
    prompt: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }) => void): () => void {
    console.log('[APPROVAL_TRACE][renderer:ipc] onInputRequired subscription setup');
    if (!this.api) {
      console.warn('[APPROVAL_TRACE][renderer:ipc] onInputRequired unavailable (no Electron API)');
      return () => { /* noop */ };
    }
    return this.api.onInputRequired((payload) => {
      const metadata = payload.metadata || {};
      const approvalTraceId = typeof metadata['approvalTraceId'] === 'string'
        ? String(metadata['approvalTraceId'])
        : `approval-renderer-ipc-${payload.requestId}`;
      console.log('[APPROVAL_TRACE][renderer:ipc] received', {
        approvalTraceId,
        instanceId: payload.instanceId,
        requestId: payload.requestId,
        metadataType: metadata['type']
      });
      this.ngZone.run(() => {
        console.log('[APPROVAL_TRACE][renderer:ipc] callback_dispatch', {
          approvalTraceId,
          instanceId: payload.instanceId,
          requestId: payload.requestId
        });
        callback(payload);
      });
    });
  }

  /**
   * Respond to an input required event (for permission prompts)
   */
  async respondToInputRequired(
    instanceId: string,
    requestId: string,
    response: string,
    permissionKey?: string,
    decisionAction?: 'allow' | 'deny' | 'modify',
    decisionScope?: 'once' | 'session' | 'always',
    metadata?: Record<string, unknown>,
    updatedInput?: Record<string, unknown>
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.respondToInputRequired(instanceId, requestId, response, permissionKey, decisionAction, decisionScope, metadata, updatedInput);
  }
}
