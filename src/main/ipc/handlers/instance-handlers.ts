/**
 * Instance IPC Handlers
 * Handles instance lifecycle, control, and user action requests
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import ElectronStore from 'electron-store';
import { getLogger } from '../../logging/logger';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { generateId } from '../../../shared/utils/id-generator';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InputRequiredResponsePayloadSchema,
  InstanceQueueSavePayloadSchema,
  InstanceChangeAgentPayloadSchema,
  InstanceChangeModelPayloadSchema,
  InstanceCompactPayloadSchema,
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
  InstanceInterruptPayloadSchema,
  InstanceLoadOlderMessagesPayloadSchema,
  InstanceRenamePayloadSchema,
  InstanceRestartFreshPayloadSchema,
  InstanceRestartPayloadSchema,
  InstanceSendInputPayloadSchema,
  InstanceTerminatePayloadSchema,
  UserActionRespondRawPayloadSchema,
  UserActionResponsePayloadSchema,
} from '@contracts/schemas/instance';
import { InstanceManager } from '../../instance/instance-manager';
import { WindowManager } from '../../window-manager';
import { getSettingsManager } from '../../core/config/settings-manager';
import { getCompactionCoordinator } from '../../context/compaction-coordinator';
import { getRemoteObserverServer } from '../../remote/observer-server';
import { getSelfPermissionGranter } from '../../security/self-permission-granter';
import { getPauseCoordinator } from '../../pause/pause-coordinator';

const logger = getLogger('InstanceHandlers');

interface PersistedQueueEntry {
  message: string;
  hadAttachmentsDropped: boolean;
  retryCount?: number;
  seededAlready?: boolean;
  kind?: 'queue' | 'steer';
}

interface QueueStoreShape {
  queues?: Record<string, PersistedQueueEntry[]>;
}

interface Store<T> {
  store: T;
  set<K extends keyof T>(key: K, value: T[K]): void;
  clear(): void;
}

let queueStore: Store<QueueStoreShape> | null = null;

function getQueueStore(): Store<QueueStoreShape> {
  queueStore ??= new ElectronStore<QueueStoreShape>({
    name: 'instance-message-queue',
  }) as unknown as Store<QueueStoreShape>;
  return queueStore;
}

/**
 * Serialize instance for IPC response
 */
function serializeInstance(
  instance: object & { communicationTokens?: unknown }
): Record<string, unknown> {
  return {
    ...instance,
    communicationTokens:
      instance.communicationTokens instanceof Map
        ? Object.fromEntries(instance.communicationTokens)
        : instance.communicationTokens
  };
}

function createInitialUserMessage(
  message: string,
  attachments?: FileAttachment[]
): OutputMessage {
  return {
    id: generateId(),
    timestamp: Date.now(),
    type: 'user',
    content: message,
    attachments: attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: attachment.data,
    })),
  };
}

export function registerInstanceHandlers(deps: {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
}): void {
  const { instanceManager } = deps;

  // ============================================
  // Instance Lifecycle Handlers
  // ============================================

  // Create instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InstanceCreatePayloadSchema,
          payload,
          'INSTANCE_CREATE'
        );

        // Use default working directory from settings if not provided or is just '.'
        let workingDirectory = validatedPayload.workingDirectory;
        if (!workingDirectory || workingDirectory === '.') {
          const settings = getSettingsManager();
          const defaultDir = settings.get('defaultWorkingDirectory');
          if (defaultDir) {
            workingDirectory = defaultDir;
          } else {
            workingDirectory = process.cwd();
          }
        }

        const instance = await instanceManager.createInstance({
          workingDirectory,
          sessionId: validatedPayload.sessionId,
          parentId: validatedPayload.parentInstanceId,
          displayName: validatedPayload.displayName,
          initialPrompt: validatedPayload.initialPrompt,
          attachments: validatedPayload.attachments as import('../../../shared/types/instance.types').FileAttachment[] | undefined,
          yoloMode: validatedPayload.yoloMode,
          agentId: validatedPayload.agentId,
          provider: validatedPayload.provider as import('../../../shared/types/instance.types').InstanceProvider | undefined,
          modelOverride: validatedPayload.model
        });

        return {
          success: true,
          data: serializeInstance(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CREATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Create instance with initial message
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_CREATE_WITH_MESSAGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceCreateWithMessagePayloadSchema,
          payload,
          'INSTANCE_CREATE_WITH_MESSAGE'
        );
        // Use default working directory from settings if not provided or is just '.'
        let workingDirectory = validated.workingDirectory;
        if (!workingDirectory || workingDirectory === '.') {
          const settings = getSettingsManager();
          const defaultDir = settings.get('defaultWorkingDirectory');
          if (defaultDir) {
            workingDirectory = defaultDir;
          } else {
            workingDirectory = process.cwd();
          }
        }

        const attachments = validated.attachments as FileAttachment[] | undefined;

        const instance = await instanceManager.createInstance({
          workingDirectory,
          initialPrompt: validated.message,
          attachments,
          initialOutputBuffer: [createInitialUserMessage(validated.message, attachments)],
          agentId: validated.agentId,
          provider: validated.provider as import('../../../shared/types/instance.types').InstanceProvider | undefined,
          modelOverride: validated.model,
          forceNodeId: validated.forceNodeId
        });

        return {
          success: true,
          data: serializeInstance(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CREATE_WITH_MESSAGE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Send input to instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_SEND_INPUT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InstanceSendInputPayloadSchema,
          payload,
          'INSTANCE_SEND_INPUT'
        );

        logger.info('IPC INSTANCE_SEND_INPUT received', {
          instanceId: validatedPayload.instanceId,
          messageLength: validatedPayload.message?.length,
          attachmentsCount: validatedPayload.attachments?.length ?? 0,
          attachmentNames: validatedPayload.attachments?.map((a) => a.name)
        });

        await instanceManager.sendInput(
          validatedPayload.instanceId,
          validatedPayload.message,
          validatedPayload.attachments as import('../../../shared/types/instance.types').FileAttachment[] | undefined,
          { isRetry: validatedPayload.isRetry }
        );

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SEND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Terminate instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_TERMINATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InstanceTerminatePayloadSchema,
          payload,
          'INSTANCE_TERMINATE'
        );

        await instanceManager.terminateInstance(
          validatedPayload.instanceId,
          validatedPayload.graceful ?? true
        );

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TERMINATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Interrupt instance (Ctrl+C equivalent)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_INTERRUPT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceInterruptPayloadSchema, payload, 'INSTANCE_INTERRUPT');
        const success = instanceManager.interruptInstance(validated.instanceId);

        return {
          success,
          data: { interrupted: success }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INTERRUPT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Restart instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RESTART,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceRestartPayloadSchema, payload, 'INSTANCE_RESTART');
        await instanceManager.restartInstance(validated.instanceId);

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RESTART_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Restart instance with fresh context
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RESTART_FRESH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceRestartFreshPayloadSchema,
          payload,
          'INSTANCE_RESTART_FRESH'
        );
        await instanceManager.restartFreshInstance(validated.instanceId);

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RESTART_FRESH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Rename instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RENAME,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InstanceRenamePayloadSchema,
          payload,
          'INSTANCE_RENAME'
        );

        instanceManager.renameInstance(
          validatedPayload.instanceId,
          validatedPayload.displayName
        );

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'RENAME_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Change agent mode (preserves conversation context)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_CHANGE_AGENT_MODE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InstanceChangeAgentPayloadSchema,
          payload,
          'INSTANCE_CHANGE_AGENT_MODE'
        );

        const instance = await instanceManager.changeAgentMode(
          validatedPayload.instanceId,
          validatedPayload.agentId
        );

        return {
          success: true,
          data: instanceManager.serializeForIpc(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANGE_AGENT_MODE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Toggle YOLO mode (preserves conversation context)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_TOGGLE_YOLO_MODE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceInterruptPayloadSchema, payload, 'INSTANCE_TOGGLE_YOLO_MODE');
        const instance = await instanceManager.toggleYoloMode(
          validated.instanceId
        );

        return {
          success: true,
          data: instanceManager.serializeForIpc(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TOGGLE_YOLO_MODE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Change model (preserves conversation context)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_CHANGE_MODEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validatedPayload = validateIpcPayload(
          InstanceChangeModelPayloadSchema,
          payload,
          'INSTANCE_CHANGE_MODEL'
        );

        const instance = await instanceManager.changeModel(
          validatedPayload.instanceId,
          validatedPayload.model,
          validatedPayload.reasoningEffort
        );

        return {
          success: true,
          data: instanceManager.serializeForIpc(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CHANGE_MODEL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Terminate all instances
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_TERMINATE_ALL,
    async (): Promise<IpcResponse> => {
      try {
        await instanceManager.terminateAllInstances();

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TERMINATE_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get all instances
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const instances = instanceManager.getAllInstancesForIpc();

        return {
          success: true,
          data: instances
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Hibernation Handlers
  // ============================================

  // Hibernate instance (save state, kill process, keep in store)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_HIBERNATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceInterruptPayloadSchema,
          payload,
          'INSTANCE_HIBERNATE'
        );
        await instanceManager.hibernateInstance(validated.instanceId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HIBERNATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Wake instance (restore state, spawn new adapter)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_WAKE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceInterruptPayloadSchema,
          payload,
          'INSTANCE_WAKE'
        );
        await instanceManager.wakeInstance(validated.instanceId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'WAKE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Context Compaction Handlers
  // ============================================

  // Manual compact trigger
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_COMPACT,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceCompactPayloadSchema,
          payload,
          'INSTANCE_COMPACT'
        );
        const coordinator = getCompactionCoordinator();
        const result = await coordinator.compactInstance(validated.instanceId);
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COMPACT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Output History
  // ============================================

  // Load older messages from disk storage
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_LOAD_OLDER_MESSAGES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceLoadOlderMessagesPayloadSchema,
          payload,
          'INSTANCE_LOAD_OLDER_MESSAGES'
        );

        const { getOutputStorageManager } = await import('../../memory/output-storage');
        const storage = getOutputStorageManager();
        const stats = storage.getInstanceStats(validated.instanceId);

        if (!stats || stats.chunkCount === 0) {
          return { success: true, data: { messages: [], hasMore: false, totalStored: 0 } };
        }

        // If beforeChunk is specified, load chunks before it; otherwise load the latest chunks
        const endChunk = validated.beforeChunk !== undefined
          ? validated.beforeChunk - 1
          : stats.chunkCount - 1;

        if (endChunk < 0) {
          return { success: true, data: { messages: [], hasMore: false, totalStored: stats.totalMessages } };
        }

        // Load from the end working backwards to get the most recent stored messages
        const messages = await storage.loadMessages(validated.instanceId, {
          startChunk: Math.max(0, endChunk - 2), // Load up to 3 chunks (~300 messages)
          endChunk,
          limit: validated.limit,
        });

        const oldestChunkLoaded = Math.max(0, endChunk - 2);

        return {
          success: true,
          data: {
            messages,
            hasMore: oldestChunkLoaded > 0,
            oldestChunkLoaded,
            totalStored: stats.totalMessages,
          }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOAD_OLDER_MESSAGES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Queue Persistence
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_QUEUE_SAVE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const settings = getSettingsManager();
        if (!settings.get('pauseFeatureEnabled')) {
          getQueueStore().clear();
          return { success: true };
        }
        if (!settings.get('persistSessionContent')) {
          getQueueStore().clear();
          return { success: true };
        }

        const validated = validateIpcPayload(
          InstanceQueueSavePayloadSchema,
          payload,
          'INSTANCE_QUEUE_SAVE'
        );
        const store = getQueueStore();
        const queues = { ...(store.store.queues ?? {}) };
        if (validated.queue.length === 0) {
          delete queues[validated.instanceId];
        } else {
          queues[validated.instanceId] = validated.queue.map((entry) => ({
            message: entry.message,
            hadAttachmentsDropped: entry.hadAttachmentsDropped,
            retryCount: entry.retryCount,
            seededAlready: entry.seededAlready,
            kind: entry.kind,
          }));
        }
        store.set('queues', queues);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INSTANCE_QUEUE_SAVE_FAILED',
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.INSTANCE_QUEUE_LOAD_ALL, async (): Promise<IpcResponse> => {
    try {
      const settings = getSettingsManager();
      if (!settings.get('pauseFeatureEnabled')) {
        getQueueStore().clear();
        return { success: true, data: { queues: {} } };
      }
      if (!settings.get('persistSessionContent')) {
        getQueueStore().clear();
        return { success: true, data: { queues: {} } };
      }

      return { success: true, data: { queues: getQueueStore().store.queues ?? {} } };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INSTANCE_QUEUE_LOAD_ALL_FAILED',
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      };
    }
  });

  // ============================================
  // User Action Handlers
  // ============================================

  // Respond to a user action request
  ipcMain.handle(
    IPC_CHANNELS.USER_ACTION_RESPOND,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate raw payload first
        const rawPayload = validateIpcPayload(
          UserActionRespondRawPayloadSchema,
          payload,
          'USER_ACTION_RESPOND'
        );
        // Map the payload to match the schema (action is approve/reject/custom, not approved)
        const mappedPayload = {
          requestId: rawPayload.requestId,
          action: rawPayload.approved ? 'approve' : 'reject' as const,
          customValue: rawPayload.selectedOption
        };

        // Validate mapped payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          UserActionResponsePayloadSchema,
          mappedPayload,
          'USER_ACTION_RESPOND'
        );

        const orchestration = instanceManager.getOrchestrationHandler();
        orchestration.respondToUserAction(
          validatedPayload.requestId,
          validatedPayload.action === 'approve',
          validatedPayload.customValue
        );
        getRemoteObserverServer().clearPrompt(validatedPayload.requestId);

        return {
          success: true,
          data: { requestId: validatedPayload.requestId, responded: true }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'USER_ACTION_RESPOND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List all pending user action requests
  ipcMain.handle(
    IPC_CHANNELS.USER_ACTION_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const orchestration = instanceManager.getOrchestrationHandler();
        const requests = orchestration.getPendingUserActions();

        return {
          success: true,
          data: requests
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'USER_ACTION_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // List pending user action requests for a specific instance
  ipcMain.handle(
    IPC_CHANNELS.USER_ACTION_LIST_FOR_INSTANCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceInterruptPayloadSchema, payload, 'USER_ACTION_LIST_FOR_INSTANCE');
        const orchestration = instanceManager.getOrchestrationHandler();
        const requests = orchestration.getPendingUserActionsForInstance(
          validated.instanceId
        );

        return {
          success: true,
          data: requests
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'USER_ACTION_LIST_FOR_INSTANCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Handle input required responses (permission prompts)
  ipcMain.handle(
    IPC_CHANNELS.INPUT_REQUIRED_RESPOND,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        // Validate payload at IPC boundary
        const validatedPayload = validateIpcPayload(
          InputRequiredResponsePayloadSchema,
          payload,
          'INPUT_REQUIRED_RESPOND'
        );

        if (getPauseCoordinator().isPaused()) {
          return {
            success: false,
            error: {
              code: 'ORCHESTRATOR_PAUSED',
              message: 'Input response refused while orchestrator is paused',
              timestamp: Date.now(),
            },
          };
        }

        // Route deferred permission responses to the resume flow instead of stdin
        if (validatedPayload.metadata?.['type'] === 'deferred_permission') {
          const approved = validatedPayload.decisionAction === 'allow';
          await instanceManager.resumeAfterDeferredPermission(
            validatedPayload.instanceId,
            approved
          );

          if (validatedPayload.decisionAction && validatedPayload.decisionScope) {
            instanceManager.recordInputRequiredPermissionDecision({
              instanceId: validatedPayload.instanceId,
              requestId: validatedPayload.requestId,
              action: validatedPayload.decisionAction,
              scope: validatedPayload.decisionScope,
            });
          } else {
            instanceManager.clearPendingInputRequiredPermission(
              validatedPayload.instanceId,
              validatedPayload.requestId
            );
          }
          getRemoteObserverServer().clearPrompt(validatedPayload.requestId);

          return {
            success: true,
            data: { requestId: validatedPayload.requestId, responded: true, resumed: true }
          };
        }

        // Self-healing permission grant for tool_result permission denials.
        // When the user selects "Always allow" for a `permission_denial` prompt
        // (e.g. Claude was blocked from writing ~/.claude/settings.json by the
        // CLI's own internal guard), write the matching rule to the user's
        // Claude settings file and respawn the instance so the CLI picks it up.
        // See: src/main/security/self-permission-granter.ts
        if (
          validatedPayload.metadata?.['type'] === 'permission_denial' &&
          validatedPayload.decisionAction === 'allow' &&
          validatedPayload.decisionScope === 'always'
        ) {
          const meta = validatedPayload.metadata;
          const toolNameRaw = meta['tool_name'];
          const actionRaw = meta['action'];
          const fullPathRaw = meta['full_path'];
          const displayPathRaw = meta['path'];

          const grantResult = getSelfPermissionGranter().grant({
            toolName: typeof toolNameRaw === 'string' ? toolNameRaw : undefined,
            action: typeof actionRaw === 'string' ? actionRaw : undefined,
            path:
              typeof fullPathRaw === 'string'
                ? fullPathRaw
                : typeof displayPathRaw === 'string'
                  ? displayPathRaw
                  : undefined,
            // User answer #2: default grant scope is "just this file".
            scopeTree: false,
            instanceId: validatedPayload.instanceId,
            requestId: validatedPayload.requestId,
          });

          if (grantResult.ok) {
            const suffix = grantResult.alreadyExisted ? ' (already present)' : '';
            instanceManager.emitSystemMessage(
              validatedPayload.instanceId,
              `Permission rule ${grantResult.rulePattern} added to ${grantResult.settingsFile}${suffix}. Restarting session so Claude CLI picks up the new rule — please retry your request after the session reconnects.`,
              {
                selfPermissionGrant: true,
                rulePattern: grantResult.rulePattern,
                settingsFile: grantResult.settingsFile,
                alreadyExisted: grantResult.alreadyExisted,
              },
            );
          } else {
            logger.warn('Self-permission grant failed', {
              instanceId: validatedPayload.instanceId,
              requestId: validatedPayload.requestId,
              code: grantResult.code,
              message: grantResult.message,
            });
            instanceManager.emitSystemMessage(
              validatedPayload.instanceId,
              `Failed to grant permission: ${grantResult.message}${grantResult.settingsFile ? ` (settings file: ${grantResult.settingsFile})` : ''}`,
              {
                selfPermissionGrantError: true,
                code: grantResult.code,
              },
            );
          }

          if (grantResult.ok) {
            // Keep our PermissionManager in sync with what was written to
            // Claude's settings.json. Record before clearing so the pending
            // request still exists in InstanceManager.
            instanceManager.recordInputRequiredPermissionDecision({
              instanceId: validatedPayload.instanceId,
              requestId: validatedPayload.requestId,
              action: 'allow',
              scope: 'always',
            });
          } else {
            instanceManager.clearPendingInputRequiredPermission(
              validatedPayload.instanceId,
              validatedPayload.requestId,
            );
          }
          getRemoteObserverServer().clearPrompt(validatedPayload.requestId);

          // Only respawn when the grant actually landed — otherwise we'd just
          // restart the session without fixing anything.
          let respawned = false;
          if (grantResult.ok) {
            try {
              await instanceManager.respawnAfterUnexpectedExit(validatedPayload.instanceId);
              respawned = true;
            } catch (respawnErr) {
              logger.warn('Respawn after self-permission grant failed', {
                instanceId: validatedPayload.instanceId,
                requestId: validatedPayload.requestId,
                error: respawnErr instanceof Error ? respawnErr.message : String(respawnErr),
              });
              instanceManager.emitSystemMessage(
                validatedPayload.instanceId,
                `Permission rule was saved but the session could not be restarted automatically. Please restart the instance manually.`,
                { selfPermissionRespawnError: true },
              );
            }
          }

          return {
            success: true,
            data: {
              requestId: validatedPayload.requestId,
              responded: true,
              granted: grantResult.ok,
              rulePattern: grantResult.ok ? grantResult.rulePattern : undefined,
              alreadyExisted: grantResult.ok ? grantResult.alreadyExisted : undefined,
              respawned,
            },
          };
        }

        // Standard input_required flow — send the response to the CLI via stdin
        await instanceManager.sendInputResponse(
          validatedPayload.instanceId,
          validatedPayload.response,
          validatedPayload.permissionKey
        );

        // If the renderer attached a permission decision, persist it via PermissionManager.
        if (validatedPayload.decisionAction && validatedPayload.decisionScope) {
          instanceManager.recordInputRequiredPermissionDecision({
            instanceId: validatedPayload.instanceId,
            requestId: validatedPayload.requestId,
            action: validatedPayload.decisionAction,
            scope: validatedPayload.decisionScope,
          });
        } else {
          instanceManager.clearPendingInputRequiredPermission(
            validatedPayload.instanceId,
            validatedPayload.requestId
          );
        }
        getRemoteObserverServer().clearPrompt(validatedPayload.requestId);

        return {
          success: true,
          data: { requestId: validatedPayload.requestId, responded: true }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'INPUT_REQUIRED_RESPOND_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
