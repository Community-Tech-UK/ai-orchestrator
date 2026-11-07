/**
 * Instance IPC Handlers
 * Handles instance lifecycle, control, and user action requests
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import { getLogger } from '../../logging/logger'; import { addInstanceWritableRoot } from '../../instance/lifecycle/hardened-mode-scoping';
import { getIdempotencyStore, IdempotencyStore } from '../../transport/idempotency-store';
import { registerInstanceProviderLimitHandlers } from './instance-provider-limit-ipc';
import { revealHiddenAutomationSession } from '../../automations/automation-hidden-outcome';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InstanceQueueSavePayloadSchema,
  InstanceChangeAgentPayloadSchema,
  InstanceChangeModelPayloadSchema,
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
  InstanceGetPromptIndexPayloadSchema,
  InstanceInterruptPayloadSchema,
  InstanceLoadOlderMessagesPayloadSchema,
  InstanceRenamePayloadSchema,
  InstanceRestartFreshPayloadSchema,
  InstanceHardenedAllowPathPayloadSchema,
  InstanceRestartPayloadSchema,
  InstanceSendInputPayloadSchema,
  InstanceSteerInputPayloadSchema,
  InstanceTerminatePayloadSchema,
  InstanceToggleFastModePayloadSchema,
  UserActionRespondRawPayloadSchema,
  UserActionResponsePayloadSchema,
} from '@contracts/schemas/instance';
import { InstanceManager } from '../../instance/instance-manager';
import { WindowManager } from '../../window-manager';
import { getSettingsManager } from '../../core/config/settings-manager';
import {
  resolveDefaultWorkingDirectory,
  toFileAttachments,
  toInstanceProvider,
} from './instance-handlers-utils';
import { getRemoteObserverServer } from '../../remote/observer-server';
import { clearInstanceQueueStore, loadAllInstanceQueues, saveInstanceQueue } from './instance-queue-store';
import { respondToInputRequired } from './input-required-respond';
import { registerInstanceCompactionHandlers } from './instance-compaction-handlers';
import { registerInstanceCrossSessionMessagingHandlers } from './instance-cross-session-messaging-handlers';
import { serializeInstance } from './instance-handler-serializers';
import {
  createInstanceWithMessage,
  logCreateWithMessageReceived,
} from './instance-create-with-message';
import { getInstanceCreateIdempotencyCache } from './instance-create-idempotency';
import type { ComputerUseAutonomyLevel } from '../../../shared/types/desktop-gateway-settings.types';
import { registerInstanceComputerUseHandler } from './instance-computer-use-handler';
import { prepareUserClose } from './instance-close-all';
import { sendInstanceInput } from './instance-send-continuation';
import { GlobalPauseService } from '../../global-pause/global-pause-service';

const logger = getLogger('InstanceHandlers');

export function registerInstanceHandlers(deps: {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
  recordComputerUseModeChange?: (
    instanceId: string,
    previousMode: ComputerUseAutonomyLevel | undefined,
    nextMode: ComputerUseAutonomyLevel | undefined,
  ) => Promise<void>;
}): void {
  const { instanceManager } = deps;
  registerInstanceComputerUseHandler(deps);

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

        const workingDirectory = resolveDefaultWorkingDirectory(validatedPayload.workingDirectory);

        const instance = await instanceManager.createInstance({
          workingDirectory,
          additionalDirectories: validatedPayload.additionalDirectories ? [...validatedPayload.additionalDirectories] : undefined,
          sessionId: validatedPayload.sessionId,
          parentId: validatedPayload.parentInstanceId,
          displayName: validatedPayload.displayName,
          initialPrompt: validatedPayload.initialPrompt,
          attachments: toFileAttachments(validatedPayload.attachments),
          yoloMode: validatedPayload.yoloMode,
          launchMode: validatedPayload.launchMode,
          agentId: validatedPayload.agentId,
          provider: toInstanceProvider(validatedPayload.provider),
          modelOverride: validatedPayload.model,
          reasoningEffort: validatedPayload.reasoningEffort,
          modelRuntimeTarget: validatedPayload.modelRuntimeTarget,
          bareMode: validatedPayload.bareMode,
          fastModeOverride: validatedPayload.fastMode,
          forceNodeId: validatedPayload.forceNodeId,
          nodePlacement: validatedPayload.nodePlacement,
          browserToolsMode: validatedPayload.browserToolsMode,
          hardened: validatedPayload.hardened,
          signalFence: validatedPayload.signalFence,
          // Explicit Copilot account for this session, from the composer's
          // account chip. A validated safe slug, never a path.
          copilotAccountProfileId: validatedPayload.copilotAccountProfileId,
          copilotConfirmProtectedOverride: validatedPayload.copilotConfirmProtectedOverride,
          accountProfileId: validatedPayload.accountProfileId,
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
      // Logged before validation: a rejected payload used to leave no trace at
      // all in the main process, which is why a lost new-session submission
      // could not be told apart from one that was never sent.
      logCreateWithMessageReceived(logger, payload);
      try {
        const validated = validateIpcPayload(
          InstanceCreateWithMessagePayloadSchema,
          payload,
          'INSTANCE_CREATE_WITH_MESSAGE'
        );
        const workingDirectory = resolveDefaultWorkingDirectory(validated.workingDirectory);

        const attachments = toFileAttachments(validated.attachments);

        if (validated.idempotencyKey) {
          const cache = getInstanceCreateIdempotencyCache();
          const key = `create-with-message:${validated.idempotencyKey}`;
          if (cache.has(key)) {
            logger.info('Duplicate INSTANCE_CREATE_WITH_MESSAGE replayed (idempotency)', {
              submissionId: validated.idempotencyKey,
            });
          }
          return await cache.run(key, () =>
            createInstanceWithMessage(instanceManager, validated, workingDirectory, attachments),
          );
        }

        return await createInstanceWithMessage(instanceManager, validated, workingDirectory, attachments);
      } catch (error) {
        logger.error('INSTANCE_CREATE_WITH_MESSAGE failed', error as Error, {
          // Read off the raw payload: validation may be what just failed.
          submissionId: (payload as { idempotencyKey?: unknown } | null)?.idempotencyKey ?? null,
        });
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

        // B2: at-most-once — a retried send carrying the same idempotency key
        // is a duplicate and must not dispatch the input twice.
        if (validatedPayload.idempotencyKey) {
          const idemKey = IdempotencyStore.compose(
            'input',
            validatedPayload.instanceId,
            validatedPayload.idempotencyKey,
          );
          if (getIdempotencyStore().isDuplicate(idemKey)) {
            logger.info('Duplicate INSTANCE_SEND_INPUT ignored (idempotency)', {
              instanceId: validatedPayload.instanceId,
            });
            return { success: true };
          }
        }

        revealHiddenAutomationSession(instanceManager, validatedPayload.instanceId); // operator took it over
        await sendInstanceInput(instanceManager, validatedPayload);

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

  // Steer active turn through the main-process control plane.
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_STEER_INPUT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validatedPayload = validateIpcPayload(
          InstanceSteerInputPayloadSchema,
          payload,
          'INSTANCE_STEER_INPUT'
        );

        logger.info('IPC INSTANCE_STEER_INPUT received', {
          instanceId: validatedPayload.instanceId,
          messageLength: validatedPayload.message?.length,
          attachmentsCount: validatedPayload.attachments?.length ?? 0,
          attachmentNames: validatedPayload.attachments?.map((a) => a.name)
        });

        revealHiddenAutomationSession(instanceManager, validatedPayload.instanceId); // operator took it over
        await instanceManager.steerInput(
          validatedPayload.instanceId,
          validatedPayload.message,
          toFileAttachments(validatedPayload.attachments),
        );

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'STEER_FAILED',
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

        await prepareUserClose([validatedPayload.instanceId], 'one');
        GlobalPauseService.peek()?.voidTarget(validatedPayload.instanceId, 'closed-by-james');
        const { instanceId, graceful, childPolicy } = validatedPayload;
        if (childPolicy) await instanceManager.terminateInstance(instanceId, graceful ?? true, { childPolicy });
        else await instanceManager.terminateInstance(instanceId, graceful ?? true);

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
        const success = instanceManager.interruptInstance(validated.instanceId, 'renderer-ipc');

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

  // Provider-limit park: resume-now / cancel / failover-now (extracted to keep this file lean)
  registerInstanceProviderLimitHandlers({ instanceManager });

  // Restart instance
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_RESTART,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceRestartPayloadSchema, payload, 'INSTANCE_RESTART');
        revealHiddenAutomationSession(instanceManager, validated.instanceId); // operator took it over
        const outcome = await instanceManager.restartInstance(validated.instanceId);
        if (!outcome.success) {
          return {
            success: false,
            error: {
              code: 'RESTART_FAILED',
              message: outcome.error
                ? `Restart failed — the session could not be resumed: ${outcome.error}`
                : 'Restart failed — the session could not be resumed.',
              timestamp: Date.now()
            }
          };
        }

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

  // WS13 slice 3 allow-and-retry: grant a session-scoped Seatbelt writable root, then restart
  // into the rebuilt jail. Rejects non-hardened instances and relative paths; never disables the sandbox.
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_HARDENED_ALLOW_PATH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceHardenedAllowPathPayloadSchema,
          payload,
          'INSTANCE_HARDENED_ALLOW_PATH'
        );
        if (!path.isAbsolute(validated.path)) {
          throw new Error('Writable-root grants must be absolute paths');
        }
        if (!addInstanceWritableRoot(validated.instanceId, validated.path)) {
          throw new Error('Instance is not running in hardened mode');
        }
        logger.info('Hardened-mode writable root granted; restarting into rebuilt jail', {
          instanceId: validated.instanceId,
          grantedPath: validated.path,
        });
        const outcome = await instanceManager.restartInstance(validated.instanceId);
        if (!outcome.success) {
          throw new Error(
            outcome.error
              ? `Writable root granted, but restarting into the rebuilt jail failed: ${outcome.error}`
              : 'Writable root granted, but restarting into the rebuilt jail failed.',
          );
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'HARDENED_ALLOW_PATH_FAILED',
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
        revealHiddenAutomationSession(instanceManager, validated.instanceId); // operator took it over
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
        // Queue-aware: applies immediately when settled, otherwise parks the
        // request and auto-applies on the next idle (instead of being refused
        // and silently swallowed while the instance is busy).
        const instance = await instanceManager.requestYoloModeToggle(
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

  // Toggle / set fast mode (preserves conversation context via respawn-resume)
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_TOGGLE_FAST_MODE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(InstanceToggleFastModePayloadSchema, payload, 'INSTANCE_TOGGLE_FAST_MODE');
        const instance = typeof validated.fastMode === 'boolean'
          ? await instanceManager.setFastMode(validated.instanceId, validated.fastMode)
          : await instanceManager.toggleFastMode(validated.instanceId);

        return {
          success: true,
          data: instanceManager.serializeForIpc(instance)
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TOGGLE_FAST_MODE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Change model and/or provider (preserves conversation context).
  // Queue-aware: a change requested while the instance is busy is parked and
  // auto-applied on the next transition into an input-waiting status.
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

        const instance = await instanceManager.requestModelChange(
          validatedPayload.instanceId,
          {
            model: validatedPayload.model,
            reasoningEffort: validatedPayload.reasoningEffort,
            modelRuntimeTarget: validatedPayload.modelRuntimeTarget,
            provider: validatedPayload.provider,
          },
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
        await prepareUserClose(instanceManager.getAllInstances().map(instance => instance.id), 'all');
        for (const instance of instanceManager.getAllInstances()) GlobalPauseService.peek()?.voidTarget(instance.id, 'closed-by-james');
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

  registerInstanceCompactionHandlers(instanceManager);
  registerInstanceCrossSessionMessagingHandlers(instanceManager);

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
        // Page by message offset: the renderer passes back the previous
        // page's oldestOffsetLoaded as beforeOffset (omitted for the newest).
        const page = await getOutputStorageManager().loadMessagesBefore(validated.instanceId, {
          beforeOffset: validated.beforeOffset,
          limit: validated.limit,
        });

        return {
          success: true,
          data: {
            messages: page.messages,
            hasMore: page.startOffset > 0,
            oldestOffsetLoaded: page.startOffset,
            totalStored: page.totalStored,
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

  // Full user-prompt index for a session: the persisted tally of prompts
  // stored to disk plus prompts still in the main-process buffer. Keeps the
  // transcript jump rail correct when the renderer holds a bounded window.
  ipcMain.handle(
    IPC_CHANNELS.INSTANCE_GET_PROMPT_INDEX,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          InstanceGetPromptIndexPayloadSchema,
          payload,
          'INSTANCE_GET_PROMPT_INDEX'
        );

        const { getOutputStorageManager, mergePromptIndex } = await import('../../memory/output-storage');
        const stored = await getOutputStorageManager().getUserPrompts(validated.instanceId);
        const instance = instanceManager.getInstance(validated.instanceId);
        const prompts = mergePromptIndex(
          stored,
          instance?.outputBuffer ?? [],
          instance?.retainedPrompts,
        );

        return { success: true, data: { prompts } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'GET_PROMPT_INDEX_FAILED',
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
        if (!settings.get('persistSessionContent')) {
          clearInstanceQueueStore();
          return { success: true };
        }

        const validated = validateIpcPayload(
          InstanceQueueSavePayloadSchema,
          payload,
          'INSTANCE_QUEUE_SAVE'
        );
        saveInstanceQueue(validated.instanceId, validated.queue);
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
      if (!settings.get('persistSessionContent')) {
        clearInstanceQueueStore();
        return { success: true, data: { queues: {} } };
      }

      return { success: true, data: { queues: loadAllInstanceQueues() } };
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
        if (orchestration.getPendingUserActions().some(
          (request) => request.id === validatedPayload.requestId && request.requestType === 'secret_required'
        )) {
          return {
            success: false,
            error: {
              code: 'SECRET_CARD_REQUIRES_DEDICATED_CHANNEL',
              message: 'Respond to this credential request using the secure secret card.',
              timestamp: Date.now(),
            },
          };
        }
        const outcome = orchestration.respondToUserAction(
          validatedPayload.requestId,
          validatedPayload.action === 'approve',
          validatedPayload.customValue,
          'window',
        );
        // The card already ended (timed out, answered elsewhere, turn stopped): say so rather than succeed.
        if (outcome === 'not-pending') {
          getRemoteObserverServer().clearPrompt(validatedPayload.requestId);
          return {
            success: false,
            error: {
              code: 'USER_ACTION_NOT_PENDING',
              message: 'That request has already closed, so nothing was sent.',
              timestamp: Date.now(),
            },
          };
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

  // Handle input required responses (permission prompts). Lives in its own module so it can leave
  // a receipt for the reply; see input-required-respond.ts.
  ipcMain.handle(
    IPC_CHANNELS.INPUT_REQUIRED_RESPOND,
    (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> =>
      respondToInputRequired(instanceManager, payload),
  );
}
