import { randomUUID } from 'node:crypto';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  InputRequiredResponsePayloadSchema,
  UserActionRespondRawPayloadSchema,
  UserActionResponsePayloadSchema,
} from '@contracts/schemas/instance';
import {
  type LoopAttachment,
  LoopByIdPayloadSchema,
  LoopInterveneePayloadSchema,
  type LoopConfigInput,
  LoopStartPayloadSchema,
} from '@contracts/schemas/loop';
import {
  ChatCreatePayloadSchema,
  ChatIdPayloadSchema,
  ChatListPayloadSchema,
  ChatSendMessagePayloadSchema,
} from '@contracts/schemas/chat';
import { SnapshotTakePayloadSchema } from '@contracts/schemas/session';
import type { CommandName } from '../../shared/types/thin-client-event.types';
import type { IpcResponse } from '../../shared/types/ipc.types';
import type { LoopConfig, LoopState } from '../../shared/types/loop.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { ChatService } from '../chats';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { getRemoteObserverServer } from '../remote/observer-server';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getLoopStore } from '../orchestration/loop-store';
import { prepareLoopStartConfig as prepareDefaultLoopStartConfig } from '../orchestration/loop-start-config';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import {
  buildLoopInterveneChatEvent,
  buildLoopStartChatEvent,
} from '../orchestration/loop-chat-summary';
import { getChatService } from '../chats';
import { getSnapshotManager } from '../persistence/snapshot-manager';
import { getSessionContinuityManager } from '../session/session-continuity';
import {
  createInstance,
  hibernateInstance,
  interruptInstance,
  sendInput,
  terminateInstance,
  wakeInstance,
} from './thin-client-instance-commands';

type ThinClientExecutableCommand = Exclude<CommandName, 'state:subscribe' | 'state:resync'>;
type ThinClientLoopConfig = Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string };
interface ThinClientChatService {
  initialize?: () => void;
  listChats?: (options?: { includeArchived?: boolean }) => unknown;
  getChat?: (chatId: string) => Promise<unknown>;
  createChat?: (payload: Parameters<ChatService['createChat']>[0]) => Promise<unknown>;
  sendMessage?: (payload: Parameters<ChatService['sendMessage']>[0]) => Promise<unknown>;
  tryGetChat?: (chatId: string) => unknown;
  appendSystemEvent?: (payload: Parameters<ChatService['appendSystemEvent']>[0]) => Promise<unknown>;
}

export interface ThinClientCommandExecutorDeps {
  instanceManager: Pick<
    InstanceManager,
    | 'appendSyntheticUserMessage'
    | 'clearPendingInputRequiredPermission'
    | 'createInstance'
    | 'getAllInstancesForIpc'
    | 'getInstance'
    | 'getOrchestrationHandler'
    | 'hibernateInstance'
    | 'interruptInstance'
    | 'recordInputRequiredPermissionDecision'
    | 'resumeAfterDeferredPermission'
    | 'sendInput'
    | 'sendInputResponse'
    | 'terminateInstance'
    | 'wakeInstance'
  >;
  getDefaultWorkingDirectory?: () => string | null | undefined;
  pauseCoordinator?: { isPaused(): boolean };
  remoteObserver?: { clearPrompt(promptId: string): void };
  loopCoordinator?: {
    startLoop(
      chatId: string,
      config: ThinClientLoopConfig,
      attachments?: LoopAttachment[],
      options?: { existingSessionContext?: string },
    ): Promise<LoopState | unknown>;
    pauseLoop(loopRunId: string): boolean;
    resumeLoop(loopRunId: string): boolean;
    cancelLoop(loopRunId: string): Promise<boolean>;
    intervene(loopRunId: string, message: string): boolean;
    acceptCompletion(loopRunId: string): Promise<boolean>;
    getLoop(loopRunId: string): unknown;
  };
  loopStore?: { upsertRun(state: unknown): void };
  prepareLoopStartConfig?: (config: LoopConfigInput) => Promise<ThinClientLoopConfig>;
  chatService?: ThinClientChatService;
  snapshotManager?: {
    takeSnapshot(
      filePath: string,
      instanceId: string,
      sessionId?: string,
      action?: 'create' | 'modify' | 'delete',
    ): string | null;
  };
  sessionContinuityManager?: { getResumableSessions(): Promise<unknown[]> };
}

export function createThinClientCommandExecutor(
  deps: ThinClientCommandExecutorDeps,
): (cmd: ThinClientExecutableCommand, payload: unknown) => Promise<IpcResponse> {
  return async (cmd, payload) => {
    try {
      switch (cmd) {
        case 'instance:list':
          return {
            success: true,
            data: deps.instanceManager.getAllInstancesForIpc(),
          };
        case 'instance:create':
          return await createInstance(deps, payload);
        case 'instance:send-input':
          return await sendInput(deps, payload);
        case 'instance:terminate':
          return await terminateInstance(deps, payload);
        case 'instance:interrupt':
          return interruptInstance(deps, payload);
        case 'instance:hibernate':
          return await hibernateInstance(deps, payload);
        case 'instance:wake':
          return await wakeInstance(deps, payload);
        case 'instance:respond-input':
          return await respondInput(deps, payload);
        case 'instance:respond-action':
          return respondAction(deps, payload);
        case 'loop:start':
          return await startLoop(deps, payload);
        case 'loop:pause':
          return loopById(deps, payload, 'LOOP_PAUSE', 'LOOP_PAUSE_FAILED', (coordinator, loopRunId) =>
            Promise.resolve(coordinator.pauseLoop(loopRunId))
          );
        case 'loop:resume':
          return loopById(deps, payload, 'LOOP_RESUME', 'LOOP_RESUME_FAILED', (coordinator, loopRunId) =>
            Promise.resolve(coordinator.resumeLoop(loopRunId))
          );
        case 'loop:cancel':
          return loopById(deps, payload, 'LOOP_CANCEL', 'LOOP_CANCEL_FAILED', (coordinator, loopRunId) =>
            coordinator.cancelLoop(loopRunId)
          );
        case 'loop:intervene':
          return interveneLoop(deps, payload);
        case 'loop:accept-completion':
          return loopById(
            deps,
            payload,
            'LOOP_ACCEPT_COMPLETION',
            'LOOP_ACCEPT_COMPLETION_FAILED',
            (coordinator, loopRunId) => coordinator.acceptCompletion(loopRunId),
          );
        case 'chat:list':
          return listChats(deps, payload);
        case 'chat:get':
          return await getChat(deps, payload);
        case 'chat:create':
          return await createChat(deps, payload);
        case 'chat:send-message':
          return await sendChatMessage(deps, payload);
        case 'snapshot:take':
          return takeSnapshot(deps, payload);
        case 'session:list-resumable':
          return await listResumableSessions(deps);
      }
      const exhaustive: never = cmd;
      return {
        success: false,
        error: {
          code: 'THIN_CLIENT_COMMAND_UNSUPPORTED',
          message: `${exhaustive} is not supported by the thin-client WebSocket command executor`,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'THIN_CLIENT_COMMAND_FAILED',
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        },
      };
    }
  };
}

async function respondInput(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(
      InputRequiredResponsePayloadSchema,
      payload,
      'THIN_CLIENT_INPUT_REQUIRED_RESPOND',
    );
    const pauseCoordinator = deps.pauseCoordinator ?? getPauseCoordinator();
    if (pauseCoordinator.isPaused()) {
      return {
        success: false,
        error: {
          code: 'ORCHESTRATOR_PAUSED',
          message: 'Input response refused while orchestrator is paused',
          timestamp: Date.now(),
        },
      };
    }

    if (validated.metadata?.['type'] === 'deferred_permission') {
      const action = validated.decisionAction;
      if (action === 'modify' && !validated.updatedInput) {
        return {
          success: false,
          error: {
            code: 'MODIFY_WITHOUT_UPDATED_INPUT',
            message: "decisionAction 'modify' requires a non-empty updatedInput object",
            timestamp: Date.now(),
          },
        };
      }
      await deps.instanceManager.resumeAfterDeferredPermission(
        validated.instanceId,
        action !== 'deny',
        action === 'modify' ? validated.updatedInput : undefined,
      );
      recordOrClearInputPermission(deps, validated);
      clearRemotePrompt(deps, validated.requestId);
      return {
        success: true,
        data: { requestId: validated.requestId, responded: true, resumed: true },
      };
    }

    await deps.instanceManager.sendInputResponse(
      validated.instanceId,
      validated.response,
      validated.permissionKey,
    );
    recordOrClearInputPermission(deps, validated);
    clearRemotePrompt(deps, validated.requestId);
    return {
      success: true,
      data: { requestId: validated.requestId, responded: true },
    };
  } catch (error) {
    return errorResponse('INPUT_REQUIRED_RESPOND_FAILED', error);
  }
}

function respondAction(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): IpcResponse {
  try {
    const rawPayload = validateIpcPayload(
      UserActionRespondRawPayloadSchema,
      payload,
      'THIN_CLIENT_USER_ACTION_RESPOND',
    );
    const validated = validateIpcPayload(
      UserActionResponsePayloadSchema,
      {
        requestId: rawPayload.requestId,
        action: rawPayload.approved ? 'approve' : 'reject',
        customValue: rawPayload.selectedOption,
      },
      'THIN_CLIENT_USER_ACTION_RESPOND',
    );
    deps.instanceManager.getOrchestrationHandler().respondToUserAction(
      validated.requestId,
      validated.action === 'approve',
      validated.customValue,
    );
    clearRemotePrompt(deps, validated.requestId);
    return {
      success: true,
      data: { requestId: validated.requestId, responded: true },
    };
  } catch (error) {
    return errorResponse('USER_ACTION_RESPOND_FAILED', error);
  }
}

async function startLoop(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(LoopStartPayloadSchema, payload, 'THIN_CLIENT_LOOP_START');
    const prepareConfig = deps.prepareLoopStartConfig ?? prepareDefaultLoopStartConfig;
    const startConfig = await prepareConfig(validated.config);
    const coordinator = deps.loopCoordinator ?? getLoopCoordinator();
    const state = await coordinator.startLoop(
      validated.chatId,
      startConfig,
      validated.attachments,
      {
        existingSessionContext: buildExistingSessionContext(
          deps.instanceManager,
          validated.chatId,
        ),
      },
    );
    upsertLoopRun(deps, state);
    appendLoopStartPrompt(deps, state);
    return { success: true, data: { state } };
  } catch (error) {
    return errorResponse('LOOP_START_FAILED', error);
  }
}

async function loopById(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
  validationContext: string,
  errorCode: string,
  action: (
    coordinator: NonNullable<ThinClientCommandExecutorDeps['loopCoordinator']>,
    loopRunId: string,
  ) => Promise<boolean>,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, `THIN_CLIENT_${validationContext}`);
    const coordinator = getLoopCoordinatorForDeps(deps);
    const ok = await action(coordinator, validated.loopRunId);
    const state = coordinator.getLoop(validated.loopRunId);
    upsertLoopRun(deps, state);
    return { success: true, data: { ok, state } };
  } catch (error) {
    return errorResponse(errorCode, error);
  }
}

function interveneLoop(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): IpcResponse {
  try {
    const validated = validateIpcPayload(LoopInterveneePayloadSchema, payload, 'THIN_CLIENT_LOOP_INTERVENE');
    const coordinator = getLoopCoordinatorForDeps(deps);
    const ok = coordinator.intervene(validated.loopRunId, validated.message);
    if (ok) {
      appendLoopInterveneMessage(deps, coordinator.getLoop(validated.loopRunId), validated.message);
    }
    return { success: true, data: { ok } };
  } catch (error) {
    return errorResponse('LOOP_INTERVENE_FAILED', error);
  }
}

function listChats(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): IpcResponse {
  try {
    const validated = validateIpcPayload(ChatListPayloadSchema, payload ?? {}, 'THIN_CLIENT_CHAT_LIST');
    const service = getChatServiceForDeps(deps);
    return { success: true, data: service.listChats?.(validated ?? {}) };
  } catch (error) {
    return errorResponse('CHAT_LIST_FAILED', error);
  }
}

async function getChat(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(ChatIdPayloadSchema, payload, 'THIN_CLIENT_CHAT_GET');
    const service = getChatServiceForDeps(deps);
    return { success: true, data: await service.getChat?.(validated.chatId) };
  } catch (error) {
    return errorResponse('CHAT_GET_FAILED', error);
  }
}

async function createChat(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(ChatCreatePayloadSchema, payload, 'THIN_CLIENT_CHAT_CREATE');
    const service = getChatServiceForDeps(deps);
    return { success: true, data: await service.createChat?.(validated) };
  } catch (error) {
    return errorResponse('CHAT_CREATE_FAILED', error);
  }
}

async function sendChatMessage(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): Promise<IpcResponse> {
  try {
    const validated = validateIpcPayload(ChatSendMessagePayloadSchema, payload, 'THIN_CLIENT_CHAT_SEND_MESSAGE');
    const service = getChatServiceForDeps(deps);
    return { success: true, data: await service.sendMessage?.(validated) };
  } catch (error) {
    return errorResponse('CHAT_SEND_MESSAGE_FAILED', error);
  }
}

function takeSnapshot(
  deps: ThinClientCommandExecutorDeps,
  payload: unknown,
): IpcResponse {
  try {
    const validated = validateIpcPayload(SnapshotTakePayloadSchema, payload, 'THIN_CLIENT_SNAPSHOT_TAKE');
    const snapshots = deps.snapshotManager ?? getSnapshotManager();
    return {
      success: true,
      data: {
        snapshotId: snapshots.takeSnapshot(
          validated.filePath,
          validated.instanceId,
          validated.sessionId,
          validated.action,
        ),
      },
    };
  } catch (error) {
    return errorResponse('SNAPSHOT_TAKE_FAILED', error);
  }
}

async function listResumableSessions(
  deps: ThinClientCommandExecutorDeps,
): Promise<IpcResponse> {
  try {
    const manager = deps.sessionContinuityManager ?? getSessionContinuityManager();
    return { success: true, data: await manager.getResumableSessions() };
  } catch (error) {
    return errorResponse('SESSION_LIST_RESUMABLE_FAILED', error);
  }
}

function getLoopCoordinatorForDeps(
  deps: ThinClientCommandExecutorDeps,
): NonNullable<ThinClientCommandExecutorDeps['loopCoordinator']> {
  return deps.loopCoordinator ?? getLoopCoordinator();
}

function getLoopStoreForDeps(
  deps: ThinClientCommandExecutorDeps,
): NonNullable<ThinClientCommandExecutorDeps['loopStore']> {
  return deps.loopStore ?? getLoopStore();
}

function getChatServiceForDeps(
  deps: ThinClientCommandExecutorDeps,
): NonNullable<ThinClientCommandExecutorDeps['chatService']> {
  const service = deps.chatService ?? getChatService({ instanceManager: deps.instanceManager as InstanceManager });
  service.initialize?.();
  return service;
}

function upsertLoopRun(
  deps: ThinClientCommandExecutorDeps,
  state: unknown,
): void {
  if (!state) return;
  try {
    getLoopStoreForDeps(deps).upsertRun(state);
  } catch {
    // The existing loop IPC path also treats persistence as best-effort here.
  }
}

function buildExistingSessionContext(
  instanceManager: ThinClientCommandExecutorDeps['instanceManager'],
  chatId: string,
): string | undefined {
  const instance = instanceManager.getInstance(chatId);
  const outputBuffer = Array.isArray(instance?.outputBuffer) ? instance.outputBuffer : [];
  if (!instance || outputBuffer.length === 0) {
    return undefined;
  }

  const context = buildReplayContinuityMessage(outputBuffer, {
    reason: 'loop-existing-session',
    maxTurns: 24,
    maxCharsPerMessage: 1000,
  });
  return context
    ? [
        context,
        '',
        'Use this as prior context from the existing visible session. It is read-only background; the loop goal remains the current task.',
      ].join('\n')
    : undefined;
}

function appendLoopStartPrompt(
  deps: ThinClientCommandExecutorDeps,
  state: unknown,
): void {
  const record = asRecord(state);
  const chatId = asString(record?.['chatId']);
  if (!chatId) return;

  const chatService = getChatServiceForDeps(deps);
  if (chatService.tryGetChat?.(chatId)) {
    void chatService.appendSystemEvent?.({
      ...buildLoopStartChatEvent(state as never),
      autoName: true,
    });
    return;
  }

  if (deps.instanceManager.getInstance(chatId)) {
    const config = asRecord(record?.['config']);
    const initialPrompt = asString(config?.['initialPrompt']);
    if (!initialPrompt) return;
    deps.instanceManager.appendSyntheticUserMessage(chatId, initialPrompt, {
      autoTitle: true,
      metadata: {
        kind: 'loop-start',
        loopRunId: asString(record?.['id']),
        workspaceCwd: asString(config?.['workspaceCwd']),
      },
    });
  }
}

function appendLoopInterveneMessage(
  deps: ThinClientCommandExecutorDeps,
  state: unknown,
  message: string,
): void {
  const record = asRecord(state);
  const chatId = asString(record?.['chatId']);
  const loopRunId = asString(record?.['id']);
  if (!chatId || !loopRunId) return;

  const interventionId = randomUUID();
  const chatService = getChatServiceForDeps(deps);
  if (chatService.tryGetChat?.(chatId)) {
    void chatService.appendSystemEvent?.(buildLoopInterveneChatEvent({
      state: state as never,
      interventionId,
      message,
    }));
    return;
  }

  if (deps.instanceManager.getInstance(chatId)) {
    deps.instanceManager.appendSyntheticUserMessage(chatId, message, {
      metadata: {
        kind: 'loop-intervene',
        loopRunId,
        interventionId,
      },
    });
  }
}

function recordOrClearInputPermission(
  deps: ThinClientCommandExecutorDeps,
  payload: {
    instanceId: string;
    requestId: string;
    decisionAction?: 'allow' | 'deny' | 'modify';
    decisionScope?: 'once' | 'session' | 'always';
  },
): void {
  if (payload.decisionAction && payload.decisionScope) {
    deps.instanceManager.recordInputRequiredPermissionDecision({
      instanceId: payload.instanceId,
      requestId: payload.requestId,
      action: payload.decisionAction === 'deny' ? 'deny' : 'allow',
      scope: payload.decisionScope,
    });
    return;
  }

  deps.instanceManager.clearPendingInputRequiredPermission(
    payload.instanceId,
    payload.requestId,
  );
}

function clearRemotePrompt(
  deps: ThinClientCommandExecutorDeps,
  requestId: string,
): void {
  try {
    (deps.remoteObserver ?? getRemoteObserverServer()).clearPrompt(requestId);
  } catch {
    // Prompt cleanup is non-critical to the command response.
  }
}

function errorResponse(code: string, error: unknown): IpcResponse {
  return {
    success: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
