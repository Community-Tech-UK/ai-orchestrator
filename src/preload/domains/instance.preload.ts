import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';

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
      launchMode?: 'orchestrated' | 'interactive';
      agentId?: string;
      provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'auto';
      model?: string;
      modelRuntimeTarget?: ModelRuntimeTarget;
      bareMode?: boolean;
      fastMode?: boolean;
      forceNodeId?: string;
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
      launchMode?: 'orchestrated' | 'interactive';
      agentId?: string;
      provider?: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'copilot' | 'cursor' | 'grok' | 'auto';
      model?: string;
      modelRuntimeTarget?: ModelRuntimeTarget;
      yoloMode?: boolean;
      bareMode?: boolean;
      fastMode?: boolean;
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
     * Steer the active turn with a follow-up message.
     */
    steerInput: (payload: {
      instanceId: string;
      message: string;
      attachments?: unknown[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_STEER_INPUT, payload);
    },

    instanceQueueSave: (payload: {
      instanceId: string;
      queue: {
        message: string;
        hadAttachmentsDropped: boolean;
        retryCount?: number;
        seededAlready?: boolean;
        kind?: 'queue' | 'steer';
      }[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_QUEUE_SAVE, payload);
    },

    instanceQueueLoadAll: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_QUEUE_LOAD_ALL);
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
     * Resume a session parked on a provider limit immediately (skip the wait).
     */
    providerLimitResumeNow: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_PROVIDER_LIMIT_RESUME_NOW, payload);
    },

    /**
     * Cancel a provider-limit park so the session will not auto-resume.
     */
    providerLimitCancel: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_PROVIDER_LIMIT_CANCEL, payload);
    },

    /**
     * Restart an instance
     */
    restartInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_RESTART, payload);
    },

    /**
     * Restart an instance with a fresh provider session and archived transcript.
     */
    restartFreshInstance: (payload: { instanceId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_RESTART_FRESH, payload);
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

    recoverCompactionContext: (payload: {
      instanceId: string;
      markerId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_RECOVER_COMPACTION_CONTEXT, payload);
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
     * Toggle or set fast mode for an instance (preserves conversation context).
     * Omit `fastMode` to flip the current value.
     */
    toggleFastMode: (payload: {
      instanceId: string;
      fastMode?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTANCE_TOGGLE_FAST_MODE, payload);
    },

    /**
     * Subscribe to YOLO changes pushed from main: an applied toggle, or a
     * change queued/cancelled while the instance was busy. `pendingYoloMode`
     * carries the parked value (undefined when nothing is queued). Returns an
     * unsubscribe fn.
     */
    onYoloToggled: (
      callback: (payload: { instanceId: string; yoloMode: boolean; pendingYoloMode?: boolean }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: { instanceId: string; yoloMode: boolean; pendingYoloMode?: boolean }
      ): void => callback(payload);
      ipcRenderer.on(ch.INSTANCE_YOLO_TOGGLED, listener);
      return () => ipcRenderer.removeListener(ch.INSTANCE_YOLO_TOGGLED, listener);
    },

    /**
     * Subscribe to fast-mode changes pushed from main (user toggle or provider
     * auto-revert when fast mode is unavailable). Returns an unsubscribe fn.
     */
    onFastToggled: (
      callback: (payload: { instanceId: string; fastMode: boolean; reason: 'user' | 'unavailable' }) => void
    ): (() => void) => {
      const listener = (
        _event: IpcRendererEvent,
        payload: { instanceId: string; fastMode: boolean; reason: 'user' | 'unavailable' }
      ): void => callback(payload);
      ipcRenderer.on(ch.INSTANCE_FAST_TOGGLED, listener);
      return () => ipcRenderer.removeListener(ch.INSTANCE_FAST_TOGGLED, listener);
    },

    /**
     * Change model for an instance (preserves conversation context)
     */
    changeModel: (payload: {
      instanceId: string;
      model: string;
      reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow' | null;
      modelRuntimeTarget?: ModelRuntimeTarget;
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
     * Listen for batch updates
     */
    onBatchUpdate: (callback: (batch: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, batch: unknown) =>
        callback(batch);
      ipcRenderer.on(ch.INSTANCE_BATCH_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(ch.INSTANCE_BATCH_UPDATE, handler);
    },

    onInstanceQueueInitialPrompt: (callback: (payload: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown) => callback(payload);
      ipcRenderer.on(ch.INSTANCE_QUEUE_INITIAL_PROMPT, handler);
      return () => ipcRenderer.removeListener(ch.INSTANCE_QUEUE_INITIAL_PROMPT, handler);
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

    /**
     * Listen for the OS menu's Settings… action (Cmd+,).
     */
    onMenuOpenSettings: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data);
      ipcRenderer.on(ch.MENU_OPEN_SETTINGS, handler);
      return () =>
        ipcRenderer.removeListener(ch.MENU_OPEN_SETTINGS, handler);
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
     * Respond to an input required event (approve/deny/modify permission).
     *
     * When decisionAction is 'modify', updatedInput MUST be a non-empty plain object
     * containing the replacement tool input.  The backend will reject the request with
     * an explicit error if updatedInput is absent or empty — it never silently falls
     * back to approving the original (unmodified) input.
     *
     * NOTE: end-to-end 'modify' support requires the installed Claude CLI to honour
     * updatedInput in PreToolUse hook replies.  This is version-dependent and has not
     * been validated against a production CLI build.  The UI layer should gate the
     * 'modify' action behind a user-visible disclaimer until live-CLI support is
     * confirmed.
     */
    respondToInputRequired: (
      instanceId: string,
      requestId: string,
      response: string,
      permissionKey?: string,
      decisionAction?: 'allow' | 'deny' | 'modify',
      decisionScope?: 'once' | 'session' | 'always',
      metadata?: Record<string, unknown>,
      updatedInput?: Record<string, unknown>,
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INPUT_REQUIRED_RESPOND, {
        instanceId,
        requestId,
        response,
        permissionKey,
        decisionAction,
        decisionScope,
        metadata,
        updatedInput,
      });
    },
  };
}
