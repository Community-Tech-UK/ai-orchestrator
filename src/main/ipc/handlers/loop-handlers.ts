import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  LoopStartPayloadSchema,
  LoopByIdPayloadSchema,
  LoopInterveneePayloadSchema,
  LoopListByChatPayloadSchema,
  LoopGetIterationsPayloadSchema,
} from '@contracts/schemas/loop';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLoopCoordinator } from '../../orchestration/loop-coordinator';
import { getLoopStore } from '../../orchestration/loop-store';
import {
  buildLoopInterveneChatEvent,
  buildLoopStartChatEvent,
  buildLoopTerminalChatSummary,
} from '../../orchestration/loop-chat-summary';
import { getLogger } from '../../logging/logger';
import type { WindowManager } from '../../window-manager';
import type { LoopState } from '../../../shared/types/loop.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { buildReplayContinuityMessage } from '../../session/replay-continuity';
import { getChatService } from '../../chats';

const logger = getLogger('LoopHandlers');

export function registerLoopHandlers(deps: {
  windowManager: WindowManager;
  instanceManager: InstanceManager;
}): void {
  const coordinator = getLoopCoordinator();
  const store = getLoopStore();
  const chatService = getChatService({ instanceManager: deps.instanceManager });

  // ────── one-time wiring: persist + bridge events to renderer ──────

  const send = <T>(channel: string, payload: T) => {
    deps.windowManager.sendToRenderer(channel, payload);
  };

  // Persist after every iteration completes (the coordinator's hook fires
  // after iteration is sealed). Also persist run row.
  coordinator.registerIterationHook(({ state, iteration }) => {
    try {
      store.upsertRun(state);
      store.insertIteration(iteration);
    } catch (err) {
      logger.warn('LoopStore persistence failed for iteration', { error: String(err) });
    }
  });

  // Forward state changes to renderer.
  coordinator.on('loop:state-changed', (data: { loopRunId: string; state: LoopState }) => {
    try { store.upsertRun(data.state); } catch { /* logged below */ }
    if (isTerminalLoopStatus(data.state.status)) {
      try {
        chatService.appendSystemEvent(buildLoopTerminalChatSummary(data.state));
      } catch (err) {
        logger.warn('Failed to append loop terminal summary to chat', {
          loopRunId: data.loopRunId,
          chatId: data.state.chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    send(IPC_CHANNELS.LOOP_STATE_CHANGED, data);
  });
  coordinator.on('loop:started', (data: { loopRunId: string; chatId: string }) => {
    try {
      const state = coordinator.getLoop(data.loopRunId);
      if (state) {
        chatService.appendSystemEvent(buildLoopStartChatEvent(state));
      } else {
        logger.warn('loop:started fired but coordinator has no live state — chat start event skipped', {
          loopRunId: data.loopRunId,
          chatId: data.chatId,
        });
      }
    } catch (err) {
      logger.warn('Failed to append loop start event to chat', {
        loopRunId: data.loopRunId,
        chatId: data.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    send(IPC_CHANNELS.LOOP_STARTED, data);
  });
  coordinator.on('loop:iteration-started', (data: unknown) => send(IPC_CHANNELS.LOOP_ITERATION_STARTED, data));
  coordinator.on('loop:activity', (data: unknown) => send(IPC_CHANNELS.LOOP_ACTIVITY, data));
  coordinator.on('loop:iteration-complete', (data: unknown) => send(IPC_CHANNELS.LOOP_ITERATION_COMPLETE, data));
  coordinator.on('loop:paused-no-progress', (data: unknown) => send(IPC_CHANNELS.LOOP_PAUSED_NO_PROGRESS, data));
  coordinator.on('loop:claimed-done-but-failed', (data: unknown) => send(IPC_CHANNELS.LOOP_CLAIMED_DONE_BUT_FAILED, data));
  coordinator.on('loop:intervention-applied', (data: unknown) => send(IPC_CHANNELS.LOOP_INTERVENTION_APPLIED, data));
  coordinator.on('loop:completed', (data: unknown) => send(IPC_CHANNELS.LOOP_COMPLETED, data));
  coordinator.on('loop:cap-reached', (data: unknown) => send(IPC_CHANNELS.LOOP_CAP_REACHED, data));
  coordinator.on('loop:cancelled', (data: unknown) => send(IPC_CHANNELS.LOOP_CANCELLED, data));
  coordinator.on('loop:error', (data: unknown) => send(IPC_CHANNELS.LOOP_ERROR, data));

  // ────── command handlers ──────

  ipcMain.handle(IPC_CHANNELS.LOOP_START, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopStartPayloadSchema, payload, 'LOOP_START');
      const existingSessionContext = buildExistingSessionContext(
        deps.instanceManager,
        validated.chatId,
      );
      const state = await coordinator.startLoop(
        validated.chatId,
        {
          ...validated.config,
          initialPrompt: validated.config.initialPrompt,
          workspaceCwd: validated.config.workspaceCwd,
        },
        validated.attachments,
        { existingSessionContext },
      );
      try { store.upsertRun(state); } catch (err) {
        logger.warn('Initial upsertRun failed', { error: String(err) });
      }
      return { success: true, data: { state } };
    } catch (error) {
      return errorResponse('LOOP_START_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_PAUSE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_PAUSE');
      const ok = coordinator.pauseLoop(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_PAUSE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_RESUME, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_RESUME');
      const ok = coordinator.resumeLoop(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_RESUME_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_INTERVENE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopInterveneePayloadSchema, payload, 'LOOP_INTERVENE');
      const ok = coordinator.intervene(validated.loopRunId, validated.message);
      if (ok) {
        const state = coordinator.getLoop(validated.loopRunId);
        if (state) {
          try {
            // randomUUID — not Date.now() — so two interventions in the same
            // millisecond don't collide on nativeMessageId. A collision would
            // be silently swallowed by appendSystemEvent's dedupe and the
            // second nudge would vanish from chat history, which is exactly
            // the failure mode this whole change exists to fix.
            chatService.appendSystemEvent(buildLoopInterveneChatEvent({
              state,
              interventionId: randomUUID(),
              message: validated.message,
            }));
          } catch (err) {
            logger.warn('Failed to append loop intervention to chat', {
              loopRunId: validated.loopRunId,
              chatId: state.chatId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      return { success: true, data: { ok } };
    } catch (error) {
      return errorResponse('LOOP_INTERVENE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_CANCEL, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_CANCEL');
      const ok = await coordinator.cancelLoop(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_CANCEL_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_GET_STATE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_GET_STATE');
      const live = coordinator.getLoop(validated.loopRunId);
      if (live) return { success: true, data: { state: live, source: 'live' } };
      const summary = store.getRunSummary(validated.loopRunId);
      return { success: true, data: { state: null, summary, source: 'store' } };
    } catch (error) {
      return errorResponse('LOOP_GET_STATE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_LIST_RUNS_FOR_CHAT, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopListByChatPayloadSchema, payload, 'LOOP_LIST_RUNS_FOR_CHAT');
      const runs = store.listRunsForChat(validated.chatId, validated.limit ?? 25);
      return { success: true, data: { runs } };
    } catch (error) {
      return errorResponse('LOOP_LIST_RUNS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_GET_ITERATIONS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopGetIterationsPayloadSchema, payload, 'LOOP_GET_ITERATIONS');
      const iterations = store.getIterations(validated.loopRunId, validated.fromSeq, validated.toSeq);
      return { success: true, data: { iterations } };
    } catch (error) {
      return errorResponse('LOOP_GET_ITERATIONS_FAILED', error);
    }
  });
}

export function buildExistingSessionContext(
  instanceManager: InstanceManager,
  chatId: string,
): string | undefined {
  const instance = instanceManager.getInstance(chatId);
  if (!instance || instance.outputBuffer.length === 0) {
    return undefined;
  }

  const context = buildReplayContinuityMessage(instance.outputBuffer, {
    reason: 'loop-existing-session',
    maxTurns: 24,
    maxCharsPerMessage: 1000,
  });
  if (!context) {
    return undefined;
  }

  logger.info('Attached existing session context to loop start', {
    chatId,
    messageCount: instance.outputBuffer.length,
    contextLength: context.length,
  });

  return [
    context,
    '',
    'Use this as prior context from the existing visible session. It is read-only background; the loop goal remains the current task.',
  ].join('\n');
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

function isTerminalLoopStatus(status: LoopState['status']): boolean {
  return (
    status === 'completed'
    || status === 'cancelled'
    || status === 'cap-reached'
    || status === 'error'
    || status === 'no-progress'
    || status === 'verify-failed'
  );
}
