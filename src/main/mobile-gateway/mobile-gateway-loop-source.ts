import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import type { LoopRunSummary } from '../../shared/types/loop-stream.types';
import type { LoopOutstandingItem } from '../../shared/types/loop-outstanding.types';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { resumeLoopRun } from '../orchestration/loop-resume';
import { getLoopStoreService } from '../orchestration/loop-store-service';
import type {
  GatewayLoopControl,
  GatewayLoopDetailRecord,
  GatewayLoopIterationRecord,
  GatewayLoopRunRecord,
} from './mobile-gateway-loop-handlers';

function iterationRecord(iteration: LoopIteration): GatewayLoopIterationRecord {
  const summary = iteration.outputExcerpt || iteration.outputFull || '';
  return {
    seq: iteration.seq,
    stage: iteration.stage,
    startedAt: iteration.startedAt,
    endedAt: iteration.endedAt,
    verdict: iteration.verifyStatus === 'passed' ? 'OK' : iteration.verifyStatus === 'failed' ? 'CRITICAL' : 'WARN',
    testPassCount: iteration.testPassCount,
    testFailCount: iteration.testFailCount,
    filesChanged: iteration.filesChanged?.length ?? 0,
    summary,
  };
}

function fromState(state: LoopState): GatewayLoopRunRecord {
  return {
    id: state.id,
    chatId: state.chatId,
    status: state.status,
    currentStage: state.currentStage,
    iteration: state.totalIterations,
    maxIterations: state.config.caps?.maxIterations ?? null,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    totalTokens: state.totalTokens,
    totalCostCents: state.totalCostCents,
    workspaceCwd: state.config.workspaceCwd || '',
    endReason: state.endReason ?? null,
    pausedForInput: state.pendingInterventions.length > 0,
    ...(state.lastIteration ? { lastIteration: iterationRecord(state.lastIteration) } : {}),
  };
}

function fromSummary(summary: LoopRunSummary, live?: LoopState): GatewayLoopRunRecord {
  if (live) return fromState(live);
  return {
    id: summary.id,
    chatId: summary.chatId,
    status: summary.status,
    currentStage: 'IMPLEMENT',
    iteration: summary.totalIterations,
    maxIterations: null,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    totalTokens: summary.totalTokens,
    totalCostCents: summary.totalCostCents,
    workspaceCwd: summary.workspaceCwd,
    endReason: summary.endReason,
    pausedForInput: false,
  };
}

function outstandingOf(items: LoopOutstandingItem[]): GatewayLoopDetailRecord['outstanding'] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    status: item.status,
    userResponse: item.userResponse,
    recommendedAnswer: item.recommendedAnswer,
  }));
}

/** Adapts the loop coordinator and store. Pause, resume, and stop use the public control API. */
export function createLiveLoopControl(): GatewayLoopControl {
  const coordinator = getLoopCoordinator();
  const store = getLoopStoreService().store;
  const liveById = () => new Map(coordinator.getActiveLoops().map((state) => [state.id, state]));

  return {
    list() {
      const live = liveById();
      return store.listRuns(100).map((summary) => fromSummary(summary, live.get(summary.id)));
    },
    get(id) {
      const live = coordinator.getLoop(id);
      const summary = store.getRunSummary(id);
      const base = live ? fromState(live) : summary ? fromSummary(summary) : null;
      if (!base) return null;
      const stored = store.getIterations(id).map(iterationRecord);
      const iterations = stored.length
        ? stored
        : live?.lastIteration ? [iterationRecord(live.lastIteration)] : [];
      return {
        ...base,
        iterations,
        outstanding: outstandingOf(store.listOutstandingItems({
          chatId: base.chatId,
          status: 'all',
          limit: 100,
        }).filter((item) => item.loopRunId === id)),
      };
    },
    pause(id) {
      const ok = coordinator.pauseLoop(id);
      const state = coordinator.getLoop(id);
      return ok
        ? { ok: true, run: state ? fromState(state) : null }
        : { ok: false, run: state ? fromState(state) : null, error: 'This loop cannot be paused' };
    },
    async resume(id) {
      const outcome = await resumeLoopRun(coordinator, store, id);
      return outcome.ok
        ? { ok: true, run: outcome.state ? fromState(outcome.state) : null }
        : { ok: false, run: outcome.state ? fromState(outcome.state) : null, error: outcome.reason || 'This loop cannot be resumed' };
    },
    async stop(id) {
      const ok = await coordinator.cancelLoop(id);
      const summary = store.getRunSummary(id);
      const state = coordinator.getLoop(id);
      const run = state ? fromState(state) : summary ? fromSummary(summary) : null;
      return ok ? { ok: true, run } : { ok: false, run, error: 'This loop cannot be stopped' };
    },
    subscribe(listener) {
      const onState = (payload: { loopRunId?: string; state?: LoopState }) => {
        if (!payload?.loopRunId) return;
        listener(payload.loopRunId, payload.state ? fromState(payload.state) : null);
      };
      coordinator.on('loop:state-changed', onState);
      return () => coordinator.removeListener('loop:state-changed', onState);
    },
  };
}
