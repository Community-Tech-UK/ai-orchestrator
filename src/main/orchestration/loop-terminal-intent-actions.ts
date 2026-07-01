import type {
  LoopState,
  LoopTerminalIntent,
  ProgressSignalEvidence,
} from '../../shared/types/loop.types';
import { createLoopPendingInput } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import {
  archiveBlockedFileForIntent as archiveBlockedFileForIntentHelper,
} from './loop-coordinator-state-helpers';
import {
  getBlockOverrideInterventionText as getBlockOverrideInterventionTextHelper,
  isToolchainClassBlock as isToolchainClassBlockHelper,
  runWorkspaceLivenessProbe as runWorkspaceLivenessProbeHelper,
} from './loop-coordinator-block-utils';

const logger = getLogger('LoopTerminalIntentActions');

type EmitLoopEvent = (eventName: string, payload: unknown) => void;

export interface ScheduledWakeup {
  intentId: string;
  summary: string;
  resumeAt: number;
}

export function scheduleWakeupIntent(params: {
  state: LoopState;
  intent: LoopTerminalIntent;
  scheduledWakeups: Map<string, ScheduledWakeup>;
  transitionTerminalIntent: (
    state: LoopState,
    intent: LoopTerminalIntent,
    status: LoopTerminalIntent['status'],
    reason: string,
  ) => LoopTerminalIntent;
  scheduleWakeupResume: (state: LoopState, opts: { resumeAt: number; reason: string }) => void;
  setConvergenceNote: (loopRunId: string, note: string) => void;
  cloneStateForBroadcast: (state: LoopState) => LoopState;
  emit: EmitLoopEvent;
}): LoopTerminalIntent | undefined {
  const { state, intent } = params;
  if (intent.kind !== 'wakeup') return undefined;
  const resumeAt = intent.resumeAt ?? Date.now() + 60_000;
  const scheduledFor = new Date(resumeAt).toISOString();
  const updated = intent.status === 'accepted'
    ? intent
    : params.transitionTerminalIntent(
      state,
      intent,
      'accepted',
      `scheduled wakeup for ${scheduledFor}`,
    );
  if (state.terminalIntentPending?.id === intent.id) state.terminalIntentPending = undefined;
  params.scheduledWakeups.set(state.id, { intentId: updated.id, summary: updated.summary, resumeAt });
  state.status = 'paused';
  state.endReason = `scheduled wakeup: ${updated.summary}`;
  params.setConvergenceNote(state.id, `scheduled wakeup until ${scheduledFor}: ${updated.summary}`);
  params.scheduleWakeupResume(state, { resumeAt, reason: updated.summary });
  params.emit('loop:wakeup-scheduled', {
    loopRunId: state.id,
    intent: updated,
    resumeAt,
    reason: updated.summary,
  });
  params.emit('loop:state-changed', { loopRunId: state.id, state: params.cloneStateForBroadcast(state) });
  logger.info('Loop wakeup scheduled', { loopRunId: state.id, intentId: updated.id, resumeAt });
  return updated;
}

export async function pauseForBlockIntentAction(params: {
  state: LoopState;
  intent: LoopTerminalIntent;
  loopControlDir: string | undefined;
  transitionTerminalIntent: (
    state: LoopState,
    intent: LoopTerminalIntent,
    status: LoopTerminalIntent['status'],
    reason: string,
  ) => LoopTerminalIntent;
  setConvergenceNote: (loopRunId: string, note: string) => void;
  cloneStateForBroadcast: (state: LoopState) => LoopState;
  emit: EmitLoopEvent;
}): Promise<void> {
  const { state, intent } = params;
  const probeCfg = state.config.blockSanityProbe;
  let failedProbeDetail: string | undefined;
  if (probeCfg?.enabled !== false && isToolchainClassBlockHelper(intent.summary, intent.evidence)) {
    const probe = await runWorkspaceLivenessProbeHelper(
      state.config.workspaceCwd,
      probeCfg?.timeoutMs ?? 5000,
    );
    if (probe.alive) {
      params.transitionTerminalIntent(
        state,
        intent,
        'rejected',
        `block not honored - liveness probe passed (${probe.detail})`,
      );
      state.terminalIntentPending = undefined;
      state.pendingInterventions.push(
        createLoopPendingInput(getBlockOverrideInterventionTextHelper(), { source: 'block-override' }),
      );
      params.setConvergenceNote(state.id, 'block overridden by liveness probe');
      params.emit('loop:activity', {
        loopRunId: state.id,
        seq: state.totalIterations,
        stage: state.currentStage,
        timestamp: Date.now(),
        kind: 'status',
        message: 'Block intent overridden: liveness probe confirmed toolchain responsive',
        detail: { intentId: intent.id, probe: probe.detail },
      });
      logger.info('Block intent overridden by liveness probe', {
        loopRunId: state.id,
        intentId: intent.id,
        probe: probe.detail,
      });
      return;
    }
    failedProbeDetail = probe.detail;
  }

  params.transitionTerminalIntent(state, intent, 'accepted', 'block intent accepted');
  state.terminalIntentPending = undefined;
  await archiveBlockedFileForIntent(params);
  state.status = 'paused';
  const signal: ProgressSignalEvidence = {
    id: 'BLOCKED',
    verdict: 'CRITICAL',
    message: failedProbeDetail
      ? `Loop-control block intent: ${intent.summary} (liveness probe failed: ${failedProbeDetail})`
      : `Loop-control block intent: ${intent.summary}`,
    detail: {
      intentId: intent.id,
      evidence: intent.evidence,
      ...(failedProbeDetail ? { probeDetail: failedProbeDetail } : {}),
    },
  };
  params.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
  params.emit('loop:state-changed', { loopRunId: state.id, state: params.cloneStateForBroadcast(state) });
  logger.info('Loop paused from loop-control block intent', {
    loopRunId: state.id,
    intentId: intent.id,
    probeDetail: failedProbeDetail,
  });
}

async function archiveBlockedFileForIntent(params: {
  state: LoopState;
  intent: LoopTerminalIntent;
  loopControlDir: string | undefined;
  emit: EmitLoopEvent;
}): Promise<void> {
  const { state, intent } = params;
  await archiveBlockedFileForIntentHelper({
    state,
    intent,
    loopControlDir: params.loopControlDir,
    debugAbsent: () => logger.debug?.('BLOCKED.md absent at archive time - operator likely removed it', {
      loopRunId: state.id,
      intentId: intent.id,
    }),
    warn: ({ errorCode, error }) => logger.warn('Failed to archive BLOCKED.md after structured block intent', {
      loopRunId: state.id,
      intentId: intent.id,
      errorCode,
      error,
    }),
    emitArchiveFailure: (failure) => params.emit('loop:claimed-done-but-failed', {
      loopRunId: state.id,
      signal: 'declared-complete',
      failure,
    }),
  });
}
