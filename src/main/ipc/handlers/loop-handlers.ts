import { registerLoopOutstandingHandlers } from './loop-outstanding-handlers';
import { registerLoopOutstandingLive } from '../../orchestration/loop-outstanding-live';
import { getNotificationService } from '../../notifications/notification-service';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  LoopStartPayloadSchema,
  LoopByIdPayloadSchema,
  LoopInterveneePayloadSchema,
  LoopListByChatPayloadSchema,
  LoopGetAwayRecapPayloadSchema,
  LoopListRunsPayloadSchema,
  LoopGetIterationsPayloadSchema,
  VerificationRunsListPayloadSchema,
  LoopInferVerifyPayloadSchema,
  LoopAssessScopePayloadSchema,
} from '@contracts/schemas/loop';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { buildAwayRecap } from '../../orchestration/away-recap';
import { registerLoopWorktreeResolveHandler } from './loop-worktree-resolve-handler';
import { isTerminalLoopRuntimeState } from '../../orchestration/loop-runtime-status';
import { getLoopCoordinator } from '../../orchestration/loop-coordinator';
import { getDocReviewService } from '../../doc-review/doc-review-service';
import { buildRunCheckpoint } from '../../orchestration/loop-checkpoint';
import { resumeLoopRun } from '../../orchestration/loop-resume';
import { cancelLoopOrCloseStoredRun } from '../../orchestration/loop-cancel-or-close';
import { getLoopStore } from '../../orchestration/loop-store';
import { inferLoopVerifyCommand } from '../../orchestration/loop-verify-command';
import { prepareLoopStartConfig, markInteractiveLoopStart } from '../../orchestration/loop-start-config';
import { assessLoopScope, type LoopScopeAssessment } from '../../orchestration/loop-scope-assessment';
import { loadLoopRecipeRegistry } from '../../orchestration/loop-recipes';
import { readUtf8FileHead } from '../../orchestration/bounded-file-read';
import { isInsideOrEqual } from '../../util/path-helpers';
import path from 'path';
import {
  appendLoopInterveneMessage,
  appendLoopIterationTranscript,
  appendLoopStartPrompt,
  appendLoopTerminalSummary,
} from './loop-transcript-dispatch';
import { getLogger } from '../../logging/logger';
import type { WindowManager } from '../../window-manager';
import { type LoopState } from '../../../shared/types/loop.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { getChatService } from '../../chats';
import { buildExistingSessionContext } from '../../orchestration/loop-existing-session-context';
import { loopCommitRatchetHook } from '../../orchestration/loop-commit-ratchet';
import { VerificationRunStore, type VerificationRun } from '../../orchestration/verification-run-store';

const logger = getLogger('LoopHandlers');

export { RESUME_OPERATOR_REVIEWED_FALLBACK_MAX_COST_CENTS } from './loop-outstanding-handlers';

export function registerLoopHandlers(deps: {
  windowManager: WindowManager;
  instanceManager: InstanceManager;
}): void {
  const coordinator = getLoopCoordinator();
  const store = getLoopStore();
  const verificationRunStore = VerificationRunStore.getInstance();
  const chatService = getChatService({ instanceManager: deps.instanceManager });

  // ────── one-time wiring: persist + bridge events to renderer ──────

  const send = <T>(channel: string, payload: T) => {
    deps.windowManager.sendToRenderer(channel, payload);
  };

  // Persist after every iteration completes (the coordinator's hook fires
  // after iteration is sealed). Also persist run row.
  coordinator.registerPreIterationHook(async ({ state }) => {
    try {
      store.persistStateCheckpoint({
        state,
        checkpoint: buildRunCheckpoint(coordinator, state, state.lastIteration),
      });
    } catch (err) {
      logger.warn('LoopStore persistence failed before iteration', {
        loopRunId: state.id,
        seq: state.inFlightIteration?.seq,
        error: String(err),
      });
      throw err;
    }
  });

  coordinator.registerIterationHook(async ({ state, iteration }) => {
    try {
      store.persistIterationSnapshot({
        state,
        iteration,
        checkpoint: buildRunCheckpoint(coordinator, state, iteration),
      });
    } catch (err) {
      logger.warn('LoopStore persistence failed for iteration', { error: String(err) });
    }
    // Close-the-loop-write-gap: record this iteration's closing message in the
    // chat's canonical ledger thread so the interactive model remembers what the
    // loop did (and it survives restart). Skipped for borrowed-adapter
    // iterations, whose stream already landed in the transcript as a normal turn.
    //
    // AWAIT this: the coordinator awaits the iteration hook, so awaiting the
    // ledger write here guarantees the iteration's assistant turn is durable
    // before the loop advances to its terminal state (which bumps the chat's
    // rebuild flag). Without the await, an instant follow-up send could rebuild
    // and clear the flag before the loop work reached the ledger.
    try {
      await appendLoopIterationTranscript(state, iteration, chatService, deps.instanceManager);
    } catch (err) {
      logger.warn('Failed to append loop iteration to chat transcript', {
        loopRunId: state.id,
        chatId: state.chatId,
        seq: iteration.seq,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await loopCommitRatchetHook({ state, iteration });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Loop commit ratchet hook failed for iteration', {
        loopRunId: state.id,
        seq: iteration.seq,
        error: message,
      });
      const failLoop = (coordinator as { failLoop?: (loopRunId: string, reason?: string) => boolean }).failLoop;
      if (typeof failLoop === 'function') {
        failLoop.call(coordinator, state.id, `Loop commit ratchet failed: ${message}`);
      }
    }
  });

  registerLoopOutstandingLive({ coordinator, store, send: payload => send(IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, payload), notify: input => getNotificationService().notify(input) });

  // NB2: persist a terminal intent BEFORE the coordinator archives its
  // source file from `<controlDir>/intents/` to `<controlDir>/imported/`.
  // The coordinator awaits this hook; if it throws, the source file
  // stays in `intents/` and the next boundary re-imports.
  coordinator.setIntentPersistHook((intent) => {
    store.upsertTerminalIntent(intent);
  });

  // Forward state changes to renderer.
  coordinator.on('loop:state-changed', (data: {
    loopRunId: string;
    state: LoopState;
    lifecycleOnly?: boolean;
  }) => {
    try {
      store.persistStateCheckpoint({
        state: data.state,
        checkpoint: buildRunCheckpoint(coordinator, data.state, data.state.lastIteration),
      });
      // Some completion metadata is attached after the normal iteration hook
      // has already sealed the row (for example finalAudit in ping-pong and
      // review-driven terminal paths). Refresh the last row on state changes so
      // history pagination and checkpoint state stay aligned.
      if (data.state.lastIteration && !data.lifecycleOnly) {
        store.insertIteration(data.state.lastIteration);
      }
    } catch (err) {
      logger.warn('LoopStore persistence failed for state change', {
        loopRunId: data.loopRunId,
        error: String(err),
      });
    }
    if (!data.lifecycleOnly && shouldAppendTerminalSummary(data.state)) {
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
    // A loop review is a gate only while the loop is parked at a real completion
    // decision. Creating one after a terminal state would falsely imply it can
    // be resumed, so terminal artifacts are deliberately informational only.
    if (
      data.state.status === 'paused'
      && (data.state.lastCompletionOutcome === 'unverifiable'
        || data.state.terminalIntentPending?.kind === 'complete')
    ) {
      void maybeCreateDocReviewForPausedLoop(coordinator, data.loopRunId);
    }
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
  coordinator.on('loop:completed-needs-review', (data: unknown) => {
    send(IPC_CHANNELS.LOOP_COMPLETED_NEEDS_REVIEW, data);
  });
  coordinator.on('loop:notes-curated', (data: unknown) => send(IPC_CHANNELS.LOOP_NOTES_CURATED, data));
  coordinator.on('loop:context-compacted', (data: unknown) => send(IPC_CHANNELS.LOOP_CONTEXT_COMPACTED, data));
  coordinator.on('loop:branch-select', (data: unknown) => send(IPC_CHANNELS.LOOP_BRANCH_SELECT, data));
  coordinator.on('loop:plan-regenerated', (data: unknown) => send(IPC_CHANNELS.LOOP_PLAN_REGENERATED, data));
  coordinator.on('loop:ledger-lint', (data: unknown) => send(IPC_CHANNELS.LOOP_LEDGER_LINT, data));
  coordinator.on('loop:steering-downgraded', (data: unknown) => send(IPC_CHANNELS.LOOP_STEERING_DOWNGRADED, data));
  coordinator.on('loop:follow-up-drained', (data: unknown) => send(IPC_CHANNELS.LOOP_FOLLOW_UP_DRAINED, data));
  coordinator.on('loop:more-work-declared', (data: unknown) => send(IPC_CHANNELS.LOOP_MORE_WORK_DECLARED, data));
  coordinator.on('loop:failed', (data: unknown) => send(IPC_CHANNELS.LOOP_FAILED, data));
  coordinator.on('loop:cap-reached', (data: unknown) => send(IPC_CHANNELS.LOOP_CAP_REACHED, data));
  coordinator.on('loop:provider-limit', (data: unknown) => send(IPC_CHANNELS.LOOP_PROVIDER_LIMIT, data));
  coordinator.on('loop:cancelled', (data: unknown) => send(IPC_CHANNELS.LOOP_CANCELLED, data));
  coordinator.on('loop:error', (data: unknown) => send(IPC_CHANNELS.LOOP_ERROR, data));

  // WS7: bounded, path-safe plan read + pure scope assessment. Read-only.
  const LOOP_SCOPE_PLAN_MAX_BYTES = 1_048_576; // 1 MiB — plans are text files.
  async function assessConfiguredPlanScope(
    workspaceCwd: string,
    planFile: string,
  ): Promise<LoopScopeAssessment> {
    const resolved = path.resolve(workspaceCwd, planFile);
    if (!isInsideOrEqual(workspaceCwd, resolved)) {
      throw new Error('planFile must resolve inside the workspace');
    }
    const { text } = await readUtf8FileHead(resolved, LOOP_SCOPE_PLAN_MAX_BYTES);
    return assessLoopScope(text);
  }

  // ────── command handlers ──────

  ipcMain.handle(IPC_CHANNELS.LOOP_START, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopStartPayloadSchema, payload, 'LOOP_START');
      const startConfig = markInteractiveLoopStart(await prepareLoopStartConfig(validated.config));
      // WS7: a configured plan whose own text contradicts single-loop
      // execution must not start as one. `campaign-required` cannot be
      // bypassed; `campaign-recommended` may proceed only with the persisted
      // deliberate override so restarts/audits show the choice was explicit.
      if (startConfig.planFile?.trim()) {
        const scopeAssessment = await assessConfiguredPlanScope(
          startConfig.workspaceCwd,
          startConfig.planFile.trim(),
        );
        const overridden = (startConfig as { singleLoopOverride?: boolean }).singleLoopOverride === true;
        if (
          scopeAssessment.disposition === 'campaign-required'
          || (scopeAssessment.disposition === 'campaign-recommended' && !overridden)
        ) {
          const required = scopeAssessment.disposition === 'campaign-required';
          logger.warn('LOOP_START refused by plan-scope assessment', {
            planFile: startConfig.planFile,
            disposition: scopeAssessment.disposition,
            reasons: scopeAssessment.reasons,
          });
          return {
            success: false,
            data: { scopeAssessment },
            error: {
              code: required ? 'LOOP_SCOPE_CAMPAIGN_REQUIRED' : 'LOOP_SCOPE_CAMPAIGN_RECOMMENDED',
              message: required
                ? `The configured plan forbids single-loop execution (${scopeAssessment.reasons.join(', ')}; `
                  + `${scopeAssessment.workstreams.length} workstreams). Run it as a campaign.`
                : `The configured plan looks larger than one loop (${scopeAssessment.reasons.join(', ')}). `
                  + 'Run it as a campaign, or re-submit with the deliberate single-loop override.',
              timestamp: Date.now(),
            },
          };
        }
      }
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

  ipcMain.handle(IPC_CHANNELS.LOOP_PINGPONG_SKIP_ROUND, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_PINGPONG_SKIP_ROUND');
      const ok = coordinator.requestPingPongSkipRound(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_PINGPONG_SKIP_ROUND_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_PINGPONG_FORCE_ARBITRATION, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_PINGPONG_FORCE_ARBITRATION');
      const ok = coordinator.requestPingPongArbitration(validated.loopRunId);
      const state = coordinator.getLoop(validated.loopRunId);
      if (state) try { store.upsertRun(state); } catch { /* noop */ }
      return { success: true, data: { ok, state } };
    } catch (error) {
      return errorResponse('LOOP_PINGPONG_FORCE_ARBITRATION_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_RESUME, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopByIdPayloadSchema, payload, 'LOOP_RESUME');
      const outcome = await resumeLoopRun(coordinator, store, validated.loopRunId);
      return { success: true, data: { ok: outcome.ok, state: outcome.state } };
    } catch (error) {
      return errorResponse('LOOP_RESUME_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_INTERVENE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopInterveneePayloadSchema, payload, 'LOOP_INTERVENE');
      const ok = coordinator.intervene(
        validated.loopRunId,
        validated.message,
        validated.kind ?? 'queue',
        validated.drainMode,
      );
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
      const ok = await cancelLoopOrCloseStoredRun(validated.loopRunId, coordinator, store);
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

  ipcMain.handle(IPC_CHANNELS.LOOP_LIST_RUNS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopListRunsPayloadSchema, payload, 'LOOP_LIST_RUNS');
      const runs = store.listRuns(validated.limit ?? 100);
      return { success: true, data: { runs } };
    } catch (error) {
      return errorResponse('LOOP_LIST_RUNS_FAILED', error);
    }
  });

  // N12: the recap the renderer shows on refocus. Main only filters `loop_runs`
  // through a caller-supplied boundary — no main-process "when were you last
  // here" state, no push channel, no window-manager changes. Zero LLM calls.
  ipcMain.handle(IPC_CHANNELS.LOOP_GET_AWAY_RECAP, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        LoopGetAwayRecapPayloadSchema, payload, 'LOOP_GET_AWAY_RECAP',
      );
      const recap = buildAwayRecap({
        runs: store.listRuns(200),
        awaySince: validated.awaySince,
        now: Date.now(),
      });
      return { success: true, data: { recap } };
    } catch (error) {
      return errorResponse('LOOP_GET_AWAY_RECAP_FAILED', error);
    }
  });

  registerLoopWorktreeResolveHandler(store);

  ipcMain.handle(IPC_CHANNELS.LOOP_GET_ITERATIONS, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopGetIterationsPayloadSchema, payload, 'LOOP_GET_ITERATIONS');
      const iterations = store.getIterations(validated.loopRunId, validated.fromSeq, validated.toSeq);
      return { success: true, data: { iterations } };
    } catch (error) {
      return errorResponse('LOOP_GET_ITERATIONS_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.VERIFICATION_RUNS_LIST, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(VerificationRunsListPayloadSchema, payload, 'VERIFICATION_RUNS_LIST');
      const runs = validated.loopRunId
        ? verificationRunStore.listForLoop(validated.loopRunId)
        : verificationRunStore.listForInstance(validated.instanceId!);
      return { success: true, data: { runs: runs.map(toVerificationRunPayload) } };
    } catch (error) {
      return errorResponse('VERIFICATION_RUNS_LIST_FAILED', error);
    }
  });

  // LF-3a: preview the auto-inferred verify command so the config panel can
  // show what will gate completion before the loop starts.
  ipcMain.handle(IPC_CHANNELS.LOOP_LIST_RECIPES, async (): Promise<IpcResponse> => {
    try {
      // Fable WS6: read-only manifest summaries for the config-panel picker.
      // forceReload so a user pack dropped in while the app runs shows up.
      const registry = loadLoopRecipeRegistry(true);
      return {
        success: true,
        data: {
          recipes: [...registry.recipes.values()].map((recipe) => ({
            name: recipe.manifest.name,
            description: recipe.manifest.description,
            source: recipe.source,
            verifyCommandSuggestions: recipe.manifest.verifyCommandSuggestions ?? [],
          })),
          diagnostics: registry.diagnostics,
        },
      };
    } catch (error) {
      return errorResponse('LOOP_LIST_RECIPES_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_ASSESS_SCOPE, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopAssessScopePayloadSchema, payload, 'LOOP_ASSESS_SCOPE');
      const assessment = await assessConfiguredPlanScope(validated.workspaceCwd, validated.planFile);
      return { success: true, data: { assessment } };
    } catch (error) {
      return errorResponse('LOOP_ASSESS_SCOPE_FAILED', error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOOP_INFER_VERIFY, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(LoopInferVerifyPayloadSchema, payload, 'LOOP_INFER_VERIFY');
      const inferred = await inferLoopVerifyCommand(validated.workspaceCwd);
      return { success: true, data: { inferred } };
    } catch (error) {
      return errorResponse('LOOP_INFER_VERIFY_FAILED', error);
    }
  });

  registerLoopOutstandingHandlers({ coordinator, store, chatService, instanceManager: deps.instanceManager, send });

}

export { buildExistingSessionContext };

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

function toVerificationRunPayload(run: VerificationRun) {
  return {
    id: run.id,
    scope: run.scope,
    loopRunId: run.loopRunId,
    instanceId: run.instanceId,
    command: run.command,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    workHash: run.workHash,
    startedAt: run.startedAt,
  };
}

function shouldAppendTerminalSummary(state: LoopState): boolean {
  return isTerminalLoopRuntimeState(state);
}

/**
 * Create the review while a loop is paused at its completion gate. Best effort only: a
 * rendering failure never changes loop control flow. The stored origin lets the delivery
 * coordinator invoke accept/intervene/resume under the loop's actual state contract.
 */
async function maybeCreateDocReviewForPausedLoop(
  coordinator: ReturnType<typeof getLoopCoordinator>,
  loopRunId: string,
): Promise<void> {
  try {
    const loop = coordinator.getLoop(loopRunId);
    const planFile = loop?.config.planFile;
    if (!loop || !planFile) return; // nothing to review without a plan
    // The loop's chatId is the instance id the decision is routed back to.
    const chatId = loop.chatId;

    const service = getDocReviewService();
    const alreadyPending = service
      .listSessions('pending')
      .some((s) => s.origin?.kind === 'loop' && s.origin.loopRunId === loopRunId);
    if (alreadyPending) return;

    await service.createReviewFromPlan({
      instanceId: chatId,
      origin: { kind: 'loop', loopRunId, chatId },
      workspacePath: loop.config.workspaceCwd,
      planFile,
    });
    logger.info('Created doc-review for paused loop completion gate', {
      loopRunId,
      planFile,
    });
  } catch (err) {
    logger.warn('Failed to auto-create doc-review for paused loop', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
