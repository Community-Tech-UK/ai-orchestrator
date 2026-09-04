import type { LoopConfig, LoopState } from '../../shared/types/loop.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import { resolveLoopChildModel } from './invocation-model-resolver';
import { shouldReanchorLoopGoal } from './loop-goal-reanchor';
import type { LoopStageMachine } from './loop-stage-machine';
import type { PendingInputLike } from './loop-stage-prompt-helpers';

export function assembleLoopIterationPrompt(input: {
  reviewDriven: boolean;
  stageMachine: LoopStageMachine;
  config: LoopConfig;
  seq: number;
  drainNowInterventions: PendingInputLike[];
  existingSessionContext?: string;
  priorObservations?: string[];
  planStageContext?: string;
  iterationPrompt?: string;
  capUsage: { totalTokens: number; totalCostCents: number };
  uncompletedPlanFilesAtStart?: string[];
  manualReviewOnly: boolean;
  reanchorGoal: boolean;
  includeSessionReplay: boolean;
  appendLoopControlPrompt: (prompt: string) => string;
}): string {
  const withCli = (body: string): string =>
    input.reanchorGoal ? input.appendLoopControlPrompt(body) : body;
  if (input.reviewDriven) {
    return withCli(input.stageMachine.buildReviewDrivenPrompt({
      config: input.config,
      iterationSeq: input.seq,
      pendingInterventions: input.drainNowInterventions,
      existingSessionContext: input.existingSessionContext,
      priorObservations: input.priorObservations,
      planStageContext: input.planStageContext,
      iterationPrompt: input.iterationPrompt,
      reanchorGoal: input.reanchorGoal,
      includeSessionReplay: input.includeSessionReplay,
    }));
  }
  return withCli(input.stageMachine.buildPrompt({
    config: input.config,
    iterationSeq: input.seq,
    pendingInterventions: input.drainNowInterventions,
    capUsage: input.capUsage,
    existingSessionContext: input.existingSessionContext,
    priorObservations: input.priorObservations,
    planStageContext: input.planStageContext,
    uncompletedPlanFilesAtStart: input.uncompletedPlanFilesAtStart,
    manualReviewOnly: input.manualReviewOnly,
    reanchorGoal: input.reanchorGoal,
    includeSessionReplay: input.includeSessionReplay,
  }));
}

/**
 * T15 — parent-chat replay is bootstrap context, not per-iteration context.
 *
 * `existingSessionContext` is a capped replay of the chat the loop was started
 * from. Re-sending it every iteration pays for it again on fresh-child and
 * hybrid strategies without adding anything: after iteration 0 the loop's own
 * state files (NOTES/ITERATION_LOG/LOOP_TASKS) carry the thread forward, and a
 * same-thread child still holds the replay in its live window.
 *
 * Send it only at the two moments where the child provably has neither: the
 * first iteration, and the first iteration after the context was recycled
 * (`pendingContextReset` — a reset scheduled for THIS turn, e.g. PLAN→IMPLEMENT;
 * `justCompacted` — the previous turn recycled into a fresh session and is
 * consumed later in this iteration).
 */
export function shouldIncludeSessionReplay(input: {
  iterationSeq: number;
  pendingContextReset: boolean;
  justCompacted: boolean;
}): boolean {
  if (input.iterationSeq <= 0) return true;
  if (input.pendingContextReset) return true;
  return input.justCompacted;
}

export async function prepareLoopIterationPrompt(input: {
  reviewDriven: boolean;
  stageMachine: LoopStageMachine;
  state: LoopState;
  seq: number;
  drainNowInterventions: PendingInputLike[];
  existingSessionContext?: string;
  priorObservations?: string[];
  planStageContext?: string;
  crossModelReviewEnabled: boolean;
  pendingContextReset: boolean;
  downshiftModel?: string;
  appendLoopControlPrompt: (prompt: string) => string;
}): Promise<{
  prompt: string;
  routingPrompt: string;
  /**
   * The prompt to send when the coordinator forces a context reset mid-attempt
   * (context-overflow recovery, circuit-breaker backoff, degraded-iteration
   * retry without thread preservation). That child is a genuinely fresh
   * session, so it needs BOTH the goal re-anchor and the parent-chat replay —
   * `routingPrompt` only guarantees the first.
   */
  freshSessionPrompt: string;
  reanchorGoal: boolean;
}> {
  const includeSessionReplay = shouldIncludeSessionReplay({
    iterationSeq: input.seq,
    pendingContextReset: input.pendingContextReset,
    justCompacted: Boolean(input.state.justCompacted),
  });
  const assemble = (reanchorGoal: boolean, replay = includeSessionReplay): string => assembleLoopIterationPrompt({
    reviewDriven: input.reviewDriven,
    stageMachine: input.stageMachine,
    config: input.state.config,
    seq: input.seq,
    drainNowInterventions: input.drainNowInterventions,
    existingSessionContext: input.existingSessionContext,
    priorObservations: input.priorObservations,
    planStageContext: input.planStageContext,
    iterationPrompt: input.state.config.iterationPrompt,
    capUsage: {
      totalTokens: input.state.totalTokens,
      totalCostCents: input.state.totalCostCents,
    },
    uncompletedPlanFilesAtStart: input.state.uncompletedPlanFilesAtStart,
    manualReviewOnly: input.state.manualReviewOnly && !input.crossModelReviewEnabled,
    reanchorGoal,
    includeSessionReplay: replay,
    appendLoopControlPrompt: input.appendLoopControlPrompt,
  });
  const routingPrompt = assemble(true);
  // When the replay is already in `routingPrompt` the two are identical, so a
  // forced reset costs nothing extra; otherwise build the replay-bearing
  // variant once.
  const freshSessionPrompt = includeSessionReplay ? routingPrompt : assemble(true, true);
  let thisAttemptModel: string | null = null;
  try {
    thisAttemptModel = await resolveLoopChildModel({
      cliType: await resolveCliType(
        input.state.config.provider as Parameters<typeof resolveCliType>[0],
        getSettingsManager().getAll().defaultCli,
      ),
      requestedProvider: input.state.config.provider,
      payloadModel: input.downshiftModel,
      routingPrompt,
    }) ?? null;
  } catch {
    thisAttemptModel = null;
  }
  const reanchorGoal = shouldReanchorLoopGoal({
    iterationSeq: input.seq,
    lastThreadCaps: input.state.lastThreadCaps,
    pendingContextReset: input.pendingContextReset,
    justCompacted: Boolean(input.state.justCompacted),
    thisAttemptModel,
  });
  return {
    routingPrompt,
    freshSessionPrompt,
    reanchorGoal,
    prompt: reanchorGoal ? routingPrompt : assemble(false),
  };
}
