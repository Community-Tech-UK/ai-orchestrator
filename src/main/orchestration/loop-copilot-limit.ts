import type { LoopState } from '../../shared/types/loop.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { LoopChildResult } from './loop-coordinator.types';
import { containsCopilotLimitNotice, matchCopilotLimitNotice } from '../cli/copilot-limit-messages';
import { isProviderNotice } from '../cli/provider-notice';

export interface LoopLimitResume {
  resumeAt: number | null;
  windowId?: string;
  earlyProbe?: boolean;
  recycle?: boolean;
}

export function isLoopProviderLimitOutput(state: LoopState, result: LoopChildResult): boolean {
  if (result.providerQuotaExhausted === true) return true;
  if (containsCopilotLimitNotice(result.output)) {
    return state.config.provider === 'copilot' && matchCopilotLimitNotice(result.output) !== null;
  }
  return isProviderNotice(result.output);
}

export function deriveCopilotLoopLimitResume(state: LoopState, text?: string): LoopLimitResume | null {
  const match = state.config.provider === 'copilot' && text ? matchCopilotLimitNotice(text) : null;
  if (!match || match.quotaVisible) return null;
  return match.action === 'recycle' ? { resumeAt: null, recycle: true }
    : { resumeAt: match.resetAtHint, earlyProbe: false };
}

/** Keep the once-per-run spend guard in checkpointed state, including across restart. */
export function recycleCopilotLimit(state: LoopState, deps: {
  requestContextReset?: (id: string) => void;
  emit: (name: string, payload: unknown) => void;
  cloneStateForBroadcast: (state: LoopState) => LoopState;
  terminate: (state: LoopState, status: LoopState['status'], reason?: string) => void;
}): 'recycled' | 'terminated' {
  if (!deps.requestContextReset) {
    deps.terminate(state, 'provider-limit', 'Copilot ended this session at its spending limit. Harness could not start a fresh session, so the run stopped.');
    return 'terminated';
  }
  if (state.endEvidence?.['copilotSessionSpendRecycled'] === true) {
    deps.terminate(state, 'provider-limit', 'Copilot reached its per-session spending limit twice in this run, so the run stopped instead of starting another session.');
    return 'terminated';
  }
  state.endEvidence = { ...state.endEvidence, copilotSessionSpendRecycled: true };
  deps.requestContextReset(state.id);
  deps.emit('loop:activity', { loopRunId: state.id, seq: state.totalIterations, stage: state.currentStage,
    timestamp: Date.now(), kind: 'status', message: 'Copilot ended this session at its spending limit. Continuing in a fresh session.' });
  deps.emit('loop:state-changed', { loopRunId: state.id, state: deps.cloneStateForBroadcast(state) });
  return 'recycled';
}

/** Existing snapshot horizon rule, extracted to keep the handler within its line budget. */
export function deriveLoopLimitSnapshotResume(snapshot: ProviderQuotaSnapshot | null): LoopLimitResume {
  if (!snapshot || !snapshot.ok) return { resumeAt: null };
  const now = Date.now();
  let best: { resetsAt: number; id: string } | null = null;
  let bestPct = -1;
  for (const w of snapshot.windows) {
    if (w.resetsAt == null || w.resetsAt <= now || w.limit <= 0) continue;
    const pct = (w.used / w.limit) * 100;
    if (pct > bestPct) {
      bestPct = pct;
      best = { resetsAt: w.resetsAt, id: w.id };
    }
  }
  return best ? { resumeAt: best.resetsAt, windowId: best.id } : { resumeAt: null };
}
