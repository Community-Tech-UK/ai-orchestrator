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

  // NB2: persist a terminal intent BEFORE the coordinator archives its
  // source file from `<controlDir>/intents/` to `<controlDir>/imported/`.
  // The coordinator awaits this hook; if it throws, the source file
  // stays in `intents/` and the next boundary re-imports.
  coordinator.setIntentPersistHook((intent) => {
    store.upsertTerminalIntent(intent);
  });

  // Forward state changes to renderer.
  coordinator.on('loop:state-changed', (data: { loopRunId: string; state: LoopState }) => {
    try { store.upsertRun(data.state); } catch { /* logged below */ }
    if (isTerminalLoopStatus(data.state.status)) {
      try {
        appendLoopTerminalSummary(data.state, chatService, deps.instanceManager);
      } catch (err) {
        logger.warn('Failed to append loop terminal summary', {
          loopRunId: data.loopRunId,
          chatId: data.state.chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    send(IPC_CHANNELS.LOOP_STATE_CHANGED, data);
  });
  coordinator.on('loop:started', (data: { loopRunId: string; chatId: string }) => {
    // Kickoff-prompt persistence runs synchronously in the LOOP_START IPC
    // handler below (right after coordinator.startLoop returns) so it
    // completes BEFORE the renderer receives the IPC response. Doing it
    // here on the listener also works in tests, but introduces a race
    // in production: chat:event is forwarded over IPC asynchronously
    // while the LOOP_START response races to the renderer first, and
    // the renderer's chat-store applies the IPC `transcript-updated`
    // event before the local `upsertActive(state)` runs — so any
    // selection change or detail refresh that depends on the new
    // state can wipe the just-appended message out of view. The
    // forward-only listener keeps the renderer notification path
    // untouched.
    send(IPC_CHANNELS.LOOP_STARTED, data);
  });
  coordinator.on('loop:iteration-started', (data: unknown) => send(IPC_CHANNELS.LOOP_ITERATION_STARTED, data));
  coordinator.on('loop:activity', (data: unknown) => send(IPC_CHANNELS.LOOP_ACTIVITY, data));
  coordinator.on('loop:iteration-complete', (data: unknown) => send(IPC_CHANNELS.LOOP_ITERATION_COMPLETE, data));
  coordinator.on('loop:paused-no-progress', (data: unknown) => send(IPC_CHANNELS.LOOP_PAUSED_NO_PROGRESS, data));
  coordinator.on('loop:claimed-done-but-failed', (data: unknown) => send(IPC_CHANNELS.LOOP_CLAIMED_DONE_BUT_FAILED, data));
  coordinator.on('loop:terminal-intent-recorded', (data: unknown) => send(IPC_CHANNELS.LOOP_TERMINAL_INTENT_RECORDED, data));
  coordinator.on('loop:terminal-intent-rejected', (data: unknown) => send(IPC_CHANNELS.LOOP_TERMINAL_INTENT_REJECTED, data));
  coordinator.on('loop:fresh-eyes-review-started', (data: unknown) => send(IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_STARTED, data));
  coordinator.on('loop:fresh-eyes-review-passed', (data: unknown) => send(IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_PASSED, data));
  coordinator.on('loop:fresh-eyes-review-failed', (data: unknown) => send(IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_FAILED, data));
  coordinator.on('loop:fresh-eyes-review-blocked', (data: unknown) => send(IPC_CHANNELS.LOOP_FRESH_EYES_REVIEW_BLOCKED, data));
  coordinator.on('loop:intervention-applied', (data: unknown) => send(IPC_CHANNELS.LOOP_INTERVENTION_APPLIED, data));
  coordinator.on('loop:completed', (data: unknown) => send(IPC_CHANNELS.LOOP_COMPLETED, data));
  coordinator.on('loop:failed', (data: unknown) => send(IPC_CHANNELS.LOOP_FAILED, data));
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
      // Persist the kickoff prompt as a user-role event in the chat
      // ledger (or as a synthetic user message on the parent instance's
      // output buffer when the loop is rooted in an instance-detail
      // view) BEFORE returning the LOOP_START response. Running here —
      // rather than in the `loop:started` listener — guarantees the
      // append is sequenced ahead of the renderer's `upsertActive`
      // call, so a chat-detail's `messages()` computed signal
      // re-evaluates against a conversation that already contains the
      // user bubble for the loop goal.
      try {
        appendLoopStartPrompt(state, chatService, deps.instanceManager);
      } catch (err) {
        logger.warn('Failed to append loop start event', {
          loopRunId: state.id,
          chatId: state.chatId,
          error: err instanceof Error ? err.message : String(err),
        });
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
            appendLoopInterveneMessage(state, validated.message, chatService, deps.instanceManager);
          } catch (err) {
            logger.warn('Failed to append loop intervention', {
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
    || status === 'failed'
    || status === 'cap-reached'
    || status === 'error'
    || status === 'no-progress'
    || status === 'verify-failed'
  );
}

/**
 * The loop's `state.chatId` can be either a chat id (when the loop was started
 * from `chat-detail.component`) or an instance id (when it was started from
 * `instance-detail.component` — see `instance-detail.component.html` where
 * `[loopChatId]="inst.id"` is passed). Both surfaces share the LOOP_START IPC
 * but write to different stores. We dispatch here so the kickoff prompt lands
 * in the correct transcript and triggers the right auto-rename hook for the
 * surface the user is actually looking at.
 */
function appendLoopStartPrompt(
  state: LoopState,
  chatService: ReturnType<typeof getChatService>,
  instanceManager: InstanceManager,
): void {
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    chatService.appendSystemEvent({
      ...buildLoopStartChatEvent(state),
      autoName: true,
    });
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    instanceManager.appendSyntheticUserMessage(state.chatId, state.config.initialPrompt, {
      autoTitle: true,
      metadata: {
        kind: 'loop-start',
        loopRunId: state.id,
        workspaceCwd: state.config.workspaceCwd,
      },
    });
    return;
  }
  logger.warn('loop:started chatId resolves to neither chat nor instance — prompt not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}

function appendLoopInterveneMessage(
  state: LoopState,
  message: string,
  chatService: ReturnType<typeof getChatService>,
  instanceManager: InstanceManager,
): void {
  const interventionId = randomUUID();
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    chatService.appendSystemEvent(buildLoopInterveneChatEvent({
      state,
      interventionId,
      message,
    }));
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    instanceManager.appendSyntheticUserMessage(state.chatId, message, {
      metadata: {
        kind: 'loop-intervene',
        loopRunId: state.id,
        interventionId,
      },
    });
    return;
  }
  logger.warn('loop intervene chatId resolves to neither chat nor instance — message not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}

function appendLoopTerminalSummary(
  state: LoopState,
  chatService: ReturnType<typeof getChatService>,
  instanceManager: InstanceManager,
): void {
  const chat = chatService.tryGetChat(state.chatId);
  if (chat) {
    chatService.appendSystemEvent(buildLoopTerminalChatSummary(state));
    return;
  }
  const instance = instanceManager.getInstance(state.chatId);
  if (instance) {
    const summary = buildLoopTerminalChatSummary(state);
    instanceManager.emitSystemMessage(state.chatId, summary.content, summary.metadata);
    return;
  }
  logger.warn('loop terminal chatId resolves to neither chat nor instance — summary not persisted', {
    loopRunId: state.id,
    chatId: state.chatId,
  });
}
