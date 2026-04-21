/**
 * Instance IPC Service - Instance lifecycle and management
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { FileAttachment } from '../../../../../shared/types/instance.types';

export interface CreateInstanceConfig {
  workingDirectory: string;
  displayName?: string;
  parentInstanceId?: string;
  initialPrompt?: string;
  yoloMode?: boolean;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
  model?: string;
  forceNodeId?: string;
}

export interface CreateInstanceWithMessageConfig {
  workingDirectory: string;
  message: string;
  attachments?: FileAttachment[];
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
  model?: string;
  forceNodeId?: string;
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
   * Change model for an instance (preserves conversation context)
   */
  async changeModel(instanceId: string, model: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.changeModel({ instanceId, model });
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
    decisionAction?: 'allow' | 'deny',
    decisionScope?: 'once' | 'session' | 'always',
    metadata?: Record<string, unknown>
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.respondToInputRequired(instanceId, requestId, response, permissionKey, decisionAction, decisionScope, metadata);
  }
}
