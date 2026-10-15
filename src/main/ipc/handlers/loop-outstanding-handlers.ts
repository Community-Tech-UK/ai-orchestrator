import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { validateIpcPayload } from '@contracts/schemas/common';
import { LoopListOutstandingPayloadSchema, LoopSetOutstandingStatusPayloadSchema, LoopExportOutstandingPayloadSchema, LoopResumeWithAnswersPayloadSchema, LoopAnswerOutstandingPayloadSchema, type LoopAnswerOutstandingPayload } from '@contracts/schemas/loop';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import { defaultLoopConfig, type LoopConfig } from '../../../shared/types/loop.types';
import type { InstanceManager } from '../../instance/instance-manager';
import type { getLoopCoordinator } from '../../orchestration/loop-coordinator';
import type { LoopStore } from '../../orchestration/loop-store';
import type { getChatService } from '../../chats';
import { getLogger } from '../../logging/logger';
import { exportOutstandingMarkdown } from '../../orchestration/loop-outstanding-export';
import { buildResumeWithAnswersPrompt } from '../../orchestration/loop-resume-with-answers';
import { buildExistingSessionContext } from '../../orchestration/loop-existing-session-context';
import { prepareLoopStartConfig, markInteractiveLoopStart } from '../../orchestration/loop-start-config';
import { appendLoopStartPrompt, appendLoopInterveneMessage } from './loop-transcript-dispatch';
import { isActiveLoopRuntimeState } from '../../orchestration/loop-runtime-status';
import { loopQuestionNeed } from '../../../shared/attention/question-need';
import { outstandingAnswerHint, outstandingUndoHint, outstandingDismissHint } from '../../orchestration/loop-outstanding-hints';
const logger = getLogger('LoopOutstandingHandlers');
/** LF-3a: operator-reviewed runs must carry a finite estimated cost cap, and
 *  the shared loop default (`DEFAULT_LOOP_MAX_COST_CENTS`) is unbounded. When
 *  resume-with-answers has to fall back to operator-reviewed completion because
 *  the source run had no verify command, it supplies this per-run cap itself
 *  instead of failing the resume. Applies only to that fallback path. */
export const RESUME_OPERATOR_REVIEWED_FALLBACK_MAX_COST_CENTS = 3_000;

export function registerLoopOutstandingHandlers(deps: {
  coordinator: ReturnType<typeof getLoopCoordinator>;
  store: LoopStore;
  chatService: ReturnType<typeof getChatService>;
  instanceManager: InstanceManager;
  send(channel: string, payload: unknown): void;
}): void {
  const { coordinator, store, chatService, send } = deps;
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
      const open = store.listOutstandingItems({
        chatId: validated.chatId,
        workspaceCwd: validated.workspaceCwd,
        status: 'open',
      });
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

      // Reuse the source config when available, but run it through the same
      // start preparation as normal LOOP_START. That preserves source choices
      // while also restoring runtime-only planner functions and applying the
      // current safety defaults for fallback runs.
      //
      // WS6 verification authority: a resumed run whose source config carried
      // no verify command (or whose config is lost) must still be startable —
      // the human is ALREADY in the loop (they just answered its questions).
      // Fall back to explicit operator-reviewed completion, which is a valid
      // authority under the policy. LF-3a requires a finite cost cap for that
      // mode and the shared default is unbounded, so the fallback carries its
      // own cap when the source run had none.
      const sourceVerify = sourceConfig?.completion?.verifyCommand?.trim() ?? '';
      const operatorReviewedFallback = sourceVerify
        ? {}
        : { allowOperatorReviewedCompletion: true };
      const withOperatorReviewedCap = (caps: LoopConfig['caps']): LoopConfig['caps'] => {
        if (sourceVerify || caps.maxCostCents !== null) return caps;
        logger.info('resume-with-answers: operator-reviewed fallback applied a finite cost cap', {
          sourceRunId,
          maxCostCents: RESUME_OPERATOR_REVIEWED_FALLBACK_MAX_COST_CENTS,
        });
        return { ...caps, maxCostCents: RESUME_OPERATOR_REVIEWED_FALLBACK_MAX_COST_CENTS };
      };
      const resumeConfig = sourceConfig
        ? {
            ...sourceConfig,
            initialPrompt: prompt,
            workspaceCwd: validated.workspaceCwd,
            planFile: undefined,
            executionCwd: undefined,
            worktreeBranch: undefined,
            nextObjectivePlanner: undefined,
            caps: withOperatorReviewedCap(sourceConfig.caps),
            completion: {
              ...sourceConfig.completion,
              requireCompletedFileRename: false,
              ...operatorReviewedFallback,
            },
          }
        : {
            initialPrompt: prompt,
            workspaceCwd: validated.workspaceCwd,
            planFile: undefined,
            caps: withOperatorReviewedCap(defaultLoopConfig(validated.workspaceCwd, prompt).caps),
            completion: {
              requireCompletedFileRename: false,
              // Keep the documented review-driven default for fallback resumes;
              // the operator-reviewed flag is the authority, not a mode switch.
              mode: 'review-driven' as const,
              ...operatorReviewedFallback,
            },
          };
      const partialConfig = markInteractiveLoopStart(await prepareLoopStartConfig(resumeConfig));

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
  ipcMain.handle(IPC_CHANNELS.LOOP_ANSWER_OUTSTANDING, async (_event, payload: unknown): Promise<IpcResponse> => {
    try {
      const input = validateIpcPayload(LoopAnswerOutstandingPayloadSchema, payload, 'LOOP_ANSWER_OUTSTANDING');
      return { success: true, data: answerOutstanding(input, deps) };
    } catch (error) { return errorResponse('LOOP_ANSWER_OUTSTANDING_FAILED', error); }
  });
}

export function answerOutstanding(input: LoopAnswerOutstandingPayload, deps: Parameters<typeof registerLoopOutstandingHandlers>[0]): { ok: boolean; delivery: 'sent-to-loop' | 'saved-for-resume' | 'recorded' } {
  const { store, coordinator } = deps;
  const item = store.getOutstandingItem(input.id);
  if (!item || item.status !== 'open') throw new Error('This item is no longer open. Refresh the questions.');
  if (input.expectedRecommendation !== item.recommendedAnswer) throw new Error('This recommendation changed. Refresh the questions and review it before answering.');
  const need = loopQuestionNeed(item);
  const state = coordinator.getLoop(item.loopRunId);
  const live = state && isActiveLoopRuntimeState(state);
  let hint: string | undefined;
  let response = input.response?.trim();
  let outcome: 'answered' | 'kept' | 'undone' | 'dismissed' | 'seen' = 'answered';
  let status: 'open' | 'resolved' | 'dismissed' = 'open';
  if (input.action === 'keep') {
    if (need !== 'applied') throw new Error('Only a low-risk applied decision can be kept. Answer this question instead.');
    outcome = 'kept'; status = 'resolved';
  } else if (input.action === 'dismiss') {
    outcome = need === 'fyi' ? 'seen' : 'dismissed'; status = 'dismissed';
    if (need === 'answer') hint = outstandingDismissHint(item.text);
  } else if (input.action === 'undo') {
    if (item.kind !== 'decision-applied') throw new Error('Only an applied decision can be undone.');
    outcome = 'undone';
    hint = outstandingUndoHint(item.text, item.recommendedAnswer ?? '', response);
    response = hint;
  } else {
    if (need !== 'answer') throw new Error('This item does not require an answer.');
    if (input.action === 'use-suggestion') response = item.recommendedAnswer?.trim();
    if (!response) throw new Error('Enter an answer or use a non-empty suggestion.');
    hint = outstandingAnswerHint(item.text, response, input.action === 'use-suggestion');
  }
  store.recordOutstandingAnswer(item.id, { response, status, outcome, ...(hint ? { answerSentAt: null } : {}) });
  let delivery: 'sent-to-loop' | 'saved-for-resume' | 'recorded' = hint && status === 'open' ? 'saved-for-resume' : 'recorded';
  if (hint && live && coordinator.intervene(item.loopRunId, hint, 'queue', undefined, 'human')) {
    store.recordOutstandingAnswer(item.id, { status, outcome, answerSentAt: Date.now() });
    appendLoopInterveneMessage(state, hint, deps.chatService, deps.instanceManager);
    delivery = 'sent-to-loop';
  }
  deps.send(IPC_CHANNELS.LOOP_OUTSTANDING_CHANGED, { loopRunId: item.loopRunId, chatId: item.chatId, workspaceCwd: item.workspaceCwd, itemId: item.id });
  return { ok: true, delivery };
}

function errorResponse(code: string, error: unknown): IpcResponse {
  return { success: false, error: { code, message: error instanceof Error ? error.message : String(error), timestamp: Date.now() } };
}
