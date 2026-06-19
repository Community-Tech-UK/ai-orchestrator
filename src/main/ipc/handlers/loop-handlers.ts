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
  LoopInferVerifyPayloadSchema,
  LoopListOutstandingPayloadSchema,
  LoopSetOutstandingStatusPayloadSchema,
  LoopExportOutstandingPayloadSchema,
  LoopResumeWithAnswersPayloadSchema,
} from '@contracts/schemas/loop';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { getLoopCoordinator } from '../../orchestration/loop-coordinator';
import { buildLoopCheckpoint } from '../../orchestration/loop-checkpoint';
import { getLoopStore } from '../../orchestration/loop-store';
import { inferLoopVerifyCommand } from '../../orchestration/loop-verify-command';
import { prepareLoopStartConfig, attachNextObjectivePlanner } from '../../orchestration/loop-start-config';
import { exportOutstandingMarkdown } from '../../orchestration/loop-outstanding-export';
import { buildResumeWithAnswersPrompt } from '../../orchestration/loop-resume-with-answers';
import {
  buildLoopInterveneChatEvent,
  buildLoopStartChatEvent,
  buildLoopTerminalChatSummary,
} from '../../orchestration/loop-chat-summary';
import { getLogger } from '../../logging/logger';
import type { WindowManager } from '../../window-manager';
import { defaultLoopConfig, type LoopState } from '../../../shared/types/loop.types';
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
      store.upsertCheckpoint(buildLoopCheckpoint({
        state,
        history: [iteration],
      }));
      // FU-3: a completed iteration means the loop is making progress
      // through restarts. Reset the consecutive-interruption counter so
      // a loop that crashed once and then ran a clean iteration is back
      // in good standing — the next boot will only re-arm the counter
      // if the iteration ends without completing.
      store.resetRestartFailureCount(state.id);
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
    try {
      store.upsertRun(data.state);
      store.upsertCheckpoint(buildLoopCheckpoint({
        state: data.state,
        history: data.state.lastIteration ? [data.state.lastIteration] : [],
      }));
    } catch { /* logged below */ }
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
      // Persist the captured OUTSTANDING.md items so human-gated work survives
      // in the aggregated Outstanding panel, then nudge the renderer to refresh.
      try {
        store.saveOutstandingItems(data.state);
        if (data.state.outstanding) {
          send(IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, {
            loopRunId: data.loopRunId,
            chatId: data.state.chatId,
            workspaceCwd: data.state.config.workspaceCwd,
          });
        }
      } catch (err) {
        logger.warn('Failed to persist loop outstanding items', {
          loopRunId: data.loopRunId,
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
    // the renderer's chat-store applies the IPC `transcript-appended`
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
  // LF-7 / LF-3: new terminal + hygiene events.
  coordinator.on('loop:completed-needs-review', (data: unknown) => send(IPC_CHANNELS.LOOP_COMPLETED_NEEDS_REVIEW, data));
  coordinator.on('loop:notes-curated', (data: unknown) => send(IPC_CHANNELS.LOOP_NOTES_CURATED, data));
  coordinator.on('loop:context-compacted', (data: unknown) => send(IPC_CHANNELS.LOOP_CONTEXT_COMPACTED, data));
  coordinator.on('loop:branch-select', (data: unknown) => send(IPC_CHANNELS.LOOP_BRANCH_SELECT, data));
  coordinator.on('loop:plan-regenerated', (data: unknown) => send(IPC_CHANNELS.LOOP_PLAN_REGENERATED, data));
  coordinator.on('loop:failed', (data: unknown) => send(IPC_CHANNELS.LOOP_FAILED, data));
  coordinator.on('loop:cap-reached', (data: unknown) => send(IPC_CHANNELS.LOOP_CAP_REACHED, data));
  coordinator.on('loop:provider-limit', (data: unknown) => send(IPC_CHANNELS.LOOP_PROVIDER_LIMIT, data));
  coordinator.on('loop:cancelled', (data: unknown) => send(IPC_CHANNELS.LOOP_CANCELLED, data));
  coordinator.on('loop:error', (data: unknown) => send(IPC_CHANNELS.LOOP_ERROR, data));

  // ────── command handlers ──────

  ipcMain.handle(IPC_CHANNELS.LOOP_START, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopStartPayloadSchema, payload, 'LOOP_START');
      const startConfig = await prepareLoopStartConfig(validated.config);
      const existingSessionContext = buildExistingSessionContext(
        deps.instanceManager,
        validated.chatId,
      );
      const state = await coordinator.startLoop(
        validated.chatId,
        {
          ...startConfig,
          initialPrompt: startConfig.initialPrompt,
          workspaceCwd: startConfig.workspaceCwd,
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
      let ok = coordinator.resumeLoop(validated.loopRunId);
      let state = coordinator.getLoop(validated.loopRunId);
      if (!ok && !state) {
        const checkpoint = store.getCheckpoint(validated.loopRunId);
        if (checkpoint) {
          state = await coordinator.restoreLoopFromCheckpoint(checkpoint);
          ok = coordinator.resumeLoop(validated.loopRunId);
          state = coordinator.getLoop(validated.loopRunId);
        }
      }
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

  // LF-7: operator accepts a paused, done-but-ungated run.
  ipcMain.handle(IPC_CHANNELS.LOOP_ACCEPT_COMPLETION, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_ACCEPT_COMPLETION');
      const ok = await coordinator.acceptCompletion(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_ACCEPT_COMPLETION_FAILED', error);
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

  // LF-3a: preview the auto-inferred verify command so the config panel can
  // show what will gate completion before the loop starts.
  ipcMain.handle(IPC_CHANNELS.LOOP_INFER_VERIFY, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopInferVerifyPayloadSchema, payload, 'LOOP_INFER_VERIFY');
      const inferred = await inferLoopVerifyCommand(validated.workspaceCwd);
      return { success: true, data: { inferred } };
    } catch (error) {
      return errorResponse('LOOP_INFER_VERIFY_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_LIST_OUTSTANDING, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopListOutstandingPayloadSchema, payload, 'LOOP_LIST_OUTSTANDING');
      const items = store.listOutstandingItems({
        chatId: validated.chatId,
        workspaceCwd: validated.workspaceCwd,
        status: validated.status,
        limit: validated.limit,
      });
      return { success: true, data: { items } };
    } catch (error) {
      return errorResponse('LOOP_LIST_OUTSTANDING_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_SET_OUTSTANDING_STATUS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopSetOutstandingStatusPayloadSchema, payload, 'LOOP_SET_OUTSTANDING_STATUS');
      const ok = store.setOutstandingItemStatus(validated.id, validated.status, validated.response);
      if (ok) send(IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, { itemId: validated.id });
      return { success: true, data: { ok } };
    } catch (error) {
      return errorResponse('LOOP_SET_OUTSTANDING_STATUS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_EXPORT_OUTSTANDING, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopExportOutstandingPayloadSchema, payload, 'LOOP_EXPORT_OUTSTANDING');
      const items = store.listOutstandingItems({
        chatId: validated.chatId,
        workspaceCwd: validated.workspaceCwd,
        status: 'open',
      });
      const result = await exportOutstandingMarkdown({
        workspaceCwd: validated.workspaceCwd,
        items,
        generatedAt: Date.now(),
        destPath: validated.destPath,
      });
      return { success: true, data: result };
    } catch (error) {
      return errorResponse('LOOP_EXPORT_OUTSTANDING_FAILED', error);
    }
  });

  // Slice 2: start a fresh loop run that applies the human answers recorded on
  // the open outstanding items. Reuses the source run's stored config (provider,
  // caps, completion gates) and feeds the decisions in as the new kickoff prompt.
  ipcMain.handle(IPC_CHANNELS.LOOP_RESUME_WITH_ANSWERS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopResumeWithAnswersPayloadSchema, payload, 'LOOP_RESUME_WITH_ANSWERS');
      const open = store.listOutstandingItems({ chatId: validated.chatId, status: 'open' });
      const answered = open.filter((i) => (i.userResponse ?? '').trim().length > 0);
      const unanswered = open.filter((i) => (i.userResponse ?? '').trim().length === 0);
      if (answered.length === 0) {
        throw new Error('No answered outstanding items to resume with. Enter an answer and Save it first.');
      }

      // Source run: explicit, else the run behind the most-recent answered item
      // (listOutstandingItems returns created_at DESC, so answered[0] is newest).
      const sourceRunId = validated.loopRunId ?? answered[0].loopRunId;
      const sourceConfig = store.getRunConfig(sourceRunId);
      const prompt = buildResumeWithAnswersPrompt({
        answered,
        unanswered,
        originalGoal: sourceConfig?.initialPrompt,
      });

      // Reuse the source config but pin the new prompt + workspace, and drop the
      // plan-file rename gate: the original plan file is unrelated to this
      // decision-application run and forcing its rename would stall completion.
      const base = sourceConfig ?? defaultLoopConfig(validated.workspaceCwd, prompt);
      // Re-attach the next-objective planner: the stored config opts in via
      // `nextObjectivePlanning`, but the runtime `nextObjectivePlanner` function
      // doesn't survive JSON serialization, so a rehydrated config would run
      // without it. `prepareLoopStartConfig` does this on the normal start path;
      // we bypass that here, so apply the same fix-up explicitly.
      const partialConfig = attachNextObjectivePlanner({
        ...base,
        initialPrompt: prompt,
        workspaceCwd: validated.workspaceCwd,
        planFile: undefined,
        nextObjectivePlanner: undefined,
        completion: { ...base.completion, requireCompletedFileRename: false },
      });

      const existingSessionContext = buildExistingSessionContext(deps.instanceManager, validated.chatId);
      const state = await coordinator.startLoop(
        validated.chatId,
        partialConfig,
        undefined,
        { existingSessionContext },
      );
      try { store.upsertRun(state); } catch (err) {
        logger.warn('resume-with-answers: initial upsertRun failed', { error: String(err) });
      }
      try {
        appendLoopStartPrompt(state, chatService, deps.instanceManager);
      } catch (err) {
        logger.warn('resume-with-answers: failed to append start prompt', { error: String(err) });
      }

      // Mark the consumed items resolved (their answer is preserved) so they
      // leave the panel, then nudge the renderer to refresh.
      let resolvedCount = 0;
      for (const item of answered) {
        if (store.setOutstandingItemStatus(item.id, 'resolved')) resolvedCount += 1;
      }
      if (resolvedCount > 0) {
        send(IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, {
          chatId: validated.chatId,
          workspaceCwd: validated.workspaceCwd,
        });
      }

      return {
        success: true,
        data: { state, resumedFromRunId: sourceRunId, appliedCount: answered.length },
      };
    } catch (error) {
      return errorResponse('LOOP_RESUME_WITH_ANSWERS_FAILED', error);
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
    || status === 'completed-needs-review'
    || status === 'cancelled'
    || status === 'failed'
    || status === 'cap-reached'
    || status === 'error'
    || status === 'no-progress'
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
    void chatService.appendSystemEvent({
      ...buildLoopStartChatEvent(state),
      autoName: true,
    }).catch((error) => {
      logger.warn('Failed to append loop start prompt to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
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
    void chatService.appendSystemEvent(buildLoopInterveneChatEvent({
      state,
      interventionId,
      message,
    })).catch((error) => {
      logger.warn('Failed to append loop intervene message to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
    void chatService.appendSystemEvent(buildLoopTerminalChatSummary(state)).catch((error) => {
      logger.warn('Failed to append loop terminal summary to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
