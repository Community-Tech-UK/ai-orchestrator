import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createInstanceDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Instance Management
    // ============================================

    /**
     * Create a new Claude instance
     */
    createInstance: (payload: {
      workingDirectory: string;
      sessionId?: string;
      parentInstanceId?: string;
      displayName?: string;
      initialPrompt?: string;
      attachments?: unknown[];
      yoloMode?: boolean;
      agentId?: string;
      provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
      model?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_CREATE, payload);
    },

    /**
     * Create a new instance and immediately send a message
     */
    createInstanceWithMessage: (payload: {
      workingDirectory: string;
      message: string;
      attachments?: unknown[];
      provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto';
      model?: string;
      forceNodeId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.INSTANCE_CREATE_WITH_MESSAGE,
        payload
      );
    },

    /**
     * Send input to an instance
     */
    sendInput: (payload: {
      instanceId: string;
      message: string;
      attachments?: unknown[];
      isRetry?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_SEND_INPUT, payload);
    },

    /**
     * Terminate an instance
     */
    terminateInstance: (payload: {
      instanceId: string;
      graceful?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_TERMINATE, payload);
    },

    /**
     * Interrupt an instance (Ctrl+C equivalent)
     * Sends SIGINT to pause the current operation without terminating
     */
    interruptInstance: (payload: {
      instanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_INTERRUPT, payload);
    },

    /**
     * Restart an instance
     */
    restartInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_RESTART, payload);
    },

    /**
     * Compact context for an instance (manual trigger)
     */
    loadOlderMessages: (payload: { instanceId: string; beforeChunk?: number; limit?: number }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_LOAD_OLDER_MESSAGES, payload);
    },

    compactInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_COMPACT, payload);
    },

    /**
     * Rename an instance
     */
    renameInstance: (payload: {
      instanceId: string;
      displayName: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_RENAME, payload);
    },

    /**
     * Change agent mode for an instance (preserves conversation context)
     */
    changeAgentMode: (payload: {
      instanceId: string;
      agentId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_CHANGE_AGENT_MODE, payload);
    },

    /**
     * Toggle YOLO mode for an instance (preserves conversation context)
     */
    toggleYoloMode: (payload: {
      instanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_TOGGLE_YOLO_MODE, payload);
    },

    /**
     * Change model for an instance (preserves conversation context)
     */
    changeModel: (payload: {
      instanceId: string;
      model: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_CHANGE_MODEL, payload);
    },

    /**
     * Terminate all instances
     */
    terminateAllInstances: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_TERMINATE_ALL);
    },

    /**
     * Get all instances
     */
    listInstances: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_LIST);
    },

    /**
     * Hibernate an instance
     */
    hibernateInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_HIBERNATE, payload);
    },

    /**
     * Wake a hibernated instance
     */
    wakeInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_WAKE, payload);
    },

    // ============================================
    // Event Listeners
    // ============================================

    /**
     * Listen for instance created events
     */
    onInstanceCreated: (callback: (instance: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, instance: unknown) =>
        callback(instance);
      ipcRenderer.on(ch.INSTANCE_CREATED, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_CREATED, handler);
    },

    /**
     * Listen for instance removed events
     */
    onInstanceRemoved: (callback: (instanceId: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, instanceId: string) =>
        callback(instanceId);
      ipcRenderer.on(ch.INSTANCE_REMOVED, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_REMOVED, handler);
    },

    /**
     * Listen for instance state updates
     */
    onInstanceStateUpdate: (
      callback: (update: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, update: unknown) =>
        callback(update);
      ipcRenderer.on(ch.INSTANCE_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_STATE_UPDATE, handler);
    },

    /**
     * Listen for instance output
     */
    onInstanceOutput: (callback: (output: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, output: unknown) =>
        callback(output);
      ipcRenderer.on(ch.INSTANCE_OUTPUT, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_OUTPUT, handler);
    },

    /**
     * Listen for batch updates
     */
    onBatchUpdate: (callback: (batch: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, batch: unknown) =>
        callback(batch);
      ipcRenderer.on(ch.INSTANCE_BATCH_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_BATCH_UPDATE, handler);
    },

    /**
     * Listen for compaction status updates
     */
    onCompactStatus: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.INSTANCE_COMPACT_STATUS, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_COMPACT_STATUS, handler);
    },

    /**
     * Listen for context warning events (75%/80%/95% thresholds)
     */
    onContextWarning: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.CONTEXT_WARNING, handler);
      return () =>
        ipcRenderer.removeListener(ch.CONTEXT_WARNING, handler);
    },

    /**
     * Listen for orchestration activity updates (child spawn, debate, verification progress)
     */
    onOrchestrationActivity: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.ORCHESTRATION_ACTIVITY, handler);
      return () =>
        ipcRenderer.removeListener(ch.ORCHESTRATION_ACTIVITY, handler);
    },

    /**
     * Listen for instance hibernated events
     */
    onInstanceHibernated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.INSTANCE_HIBERNATED, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_HIBERNATED, handler);
    },

    /**
     * Listen for instance waking events
     */
    onInstanceWaking: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.INSTANCE_WAKING, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_WAKING, handler);
    },

    /**
     * Listen for instance transcript chunk events
     */
    onInstanceTranscriptChunk: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.INSTANCE_TRANSCRIPT_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_TRANSCRIPT_CHUNK, handler);
    },

    /**
     * Listen for menu events (e.g. new instance from OS menu)
     */
    onMenuEvent: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.MENU_NEW_INSTANCE, handler);
      return () =>
        ipcRenderer.removeListener(ch.MENU_NEW_INSTANCE, handler);
    },

    // ============================================
    // User Action Requests (Orchestrator -> User)
    // ============================================

    /**
     * Listen for user action requests from the orchestrator
     */
    onUserActionRequest: (callback: (request: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, request: unknown) =>
        callback(request);
      ipcRenderer.on(ch.USER_ACTION_REQUEST, handler);
      return () =>
        ipcRenderer.removeListener(ch.USER_ACTION_REQUEST, handler);
    },

    /**
     * Respond to a user action request
     */
    respondToUserAction: (
      requestId: string,
      approved: boolean,
      selectedOption?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.USER_ACTION_RESPOND, {
        requestId,
        approved,
        selectedOption
      });
    },

    /**
     * Get all pending user action requests
     */
    listUserActionRequests: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.USER_ACTION_LIST);
    },

    /**
     * Get pending user action requests for a specific instance
     */
    listUserActionRequestsForInstance: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.USER_ACTION_LIST_FOR_INSTANCE, {
        instanceId
      });
    },

    // ============================================
    // Input Required (CLI Permission Prompts)
    // ============================================

    /**
     * Listen for input required events (permission prompts from CLI)
     */
    onInputRequired: (callback: (payload: {
      instanceId: string;
      requestId: string;
      prompt: string;
      timestamp: number;
      metadata?: Record<string, unknown>;
    }) => void): (() => void) => {
      console.log('[Preload] onInputRequired: Setting up listener');
      const handler = (_event: IpcRendererEvent, payload: {
        instanceId: string;
        requestId: string;
        prompt: string;
        timestamp: number;
        metadata?: Record<string, unknown>;
      }) => {
        console.log('=== [Preload] INPUT_REQUIRED IPC MESSAGE RECEIVED ===');
        console.log('[Preload] Payload:', JSON.stringify(payload, null, 2));
        console.log('[Preload] Calling callback...');
        callback(payload);
        console.log('[Preload] Callback executed');
        console.log('=== [Preload] INPUT_REQUIRED HANDLING COMPLETE ===');
      };
      ipcRenderer.on(ch.INPUT_REQUIRED, handler);
      console.log('[Preload] Listener registered for channel:', ch.INPUT_REQUIRED);
      return () =>
        ipcRenderer.removeListener(ch.INPUT_REQUIRED, handler);
    },

    /**
     * Respond to an input required event (approve/deny permission)
     */
    respondToInputRequired: (
      instanceId: string,
      requestId: string,
      response: string,
      permissionKey?: string,
      decisionAction?: 'allow' | 'deny',
      decisionScope?: 'once' | 'session' | 'always'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INPUT_REQUIRED_RESPOND, {
        instanceId,
        requestId,
        response,
        permissionKey,
        decisionAction,
        decisionScope
      });
    },
  };
}
