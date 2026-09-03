/**
 * Bounded next-iteration unstick on a fixable CRITICAL.
 *
 * The HUD used to ask the operator for a hint first. Review-driven loops also
 * skip the no-progress pause, and their stall guard resets on any production
 * edit — so a 43× Edit thrash never paused and never changed approach.
 * This injects one orchestrator steer (capped) before we ask a human.
 */
import {
  coercePendingInput,
  createLoopPendingInput,
  type LoopState,
} from '../../shared/types/loop.types';

export const AUTO_UNSTICK_MAX_ATTEMPTS = 2;

/**
 * Fixable thrash — not signal A. Identical work-hash already has dedicated
 * escapes (pause, plan-regen, branch-select) and is the review-driven
 * success signature.
 */
const ELIGIBLE = new Set(['G', 'B', 'E', 'I', 'D', 'D-prime', 'H']);

const SIGNAL_PRIORITY = ['G', 'B', 'E', 'I', 'D', 'D-prime', 'H'];

export interface AutoUnstickSignal {
  id: string;
  verdict: string;
  message: string;
}

export function pickAutoUnstickSignal(
  signals: readonly AutoUnstickSignal[],
): AutoUnstickSignal | null {
  const eligible = signals.filter((signal) => (
    signal.verdict === 'CRITICAL' && ELIGIBLE.has(signal.id)
  ));
  if (eligible.length === 0) return null;
  return [...eligible].sort(
    (a, b) => SIGNAL_PRIORITY.indexOf(a.id) - SIGNAL_PRIORITY.indexOf(b.id),
  )[0] ?? null;
}

export function buildAutoUnstickIntervention(
  signal: Pick<AutoUnstickSignal, 'id' | 'message'>,
  attempt: number,
  max: number,
): string {
  const header =
    `AUTOMATIC UNSTICK (${attempt}/${max}): the progress detector flagged ` +
    `this iteration as stuck — ${signal.message}`;
  const direction = directionFor(signal.id);
  return (
    `${header}\n\n${direction}\n\n` +
    'This is binding direction from the orchestrator, not a suggestion.'
  );
}

function directionFor(id: string): string {
  switch (id) {
    case 'G':
      return (
        'Stop repeating the same tool with the same arguments. Do a different ' +
        'next action: edit a different file, skip that command, or change approach.'
      );
    case 'B':
      return (
        'Stop flipping the same file back and forth. Pick one version and keep it, ' +
        'or leave that file alone.'
      );
    case 'E':
      return (
        'Stop retrying the path that keeps producing the same error. Fix the root ' +
        'cause, work around it, or skip that path.'
      );
    case 'I':
      return 'Stop re-reading the same content. You already have the answer — edit or move on.';
    case 'D':
      return (
        'Stop chasing a flipping test count. Identify the real failing test and fix ' +
        'that, or ignore a flaky count.'
      );
    case 'D-prime':
      return (
        'Files are changing but tests are not. Run the tests that should move, or ' +
        'stop editing until you know which assertion must change.'
      );
    case 'H':
      return (
        'Your last write-ups were nearly identical. Name the remaining gap and do ' +
        'that next — do not restate progress.'
      );
    default:
      return 'Change approach. Do not repeat the same action.';
  }
}

function hasSource(state: LoopState, source: string): boolean {
  return state.pendingInterventions.some(
    (item) => coercePendingInput(item).source === source,
  );
}

export function applyLoopAutoUnstickOnStall(params: {
  state: LoopState;
  seq: number;
  verdict: string;
  signals: readonly AutoUnstickSignal[];
  verifyPassed: boolean;
  attempts: number;
  emit: (eventName: string, payload: unknown) => boolean;
}): { injected: boolean; attempts: number } {
  if (params.verdict === 'OK' || params.verifyPassed) {
    params.state.autoUnstick = undefined;
    return { injected: false, attempts: 0 };
  }

  const signal = pickAutoUnstickSignal(params.signals);
  if (!signal) {
    return { injected: false, attempts: params.attempts };
  }

  if (params.verdict !== 'CRITICAL') {
    return { injected: false, attempts: params.attempts };
  }
  if (hasSource(params.state, 'human') || hasSource(params.state, 'auto-unstick')) {
    return { injected: false, attempts: params.attempts };
  }
  if (params.attempts >= AUTO_UNSTICK_MAX_ATTEMPTS) {
    return { injected: false, attempts: params.attempts };
  }

  const next = params.attempts + 1;
  params.state.pendingInterventions.push(
    createLoopPendingInput(
      buildAutoUnstickIntervention(signal, next, AUTO_UNSTICK_MAX_ATTEMPTS),
      { source: 'auto-unstick' },
    ),
  );
  params.state.autoUnstick = {
    seq: params.seq,
    attempt: next,
    max: AUTO_UNSTICK_MAX_ATTEMPTS,
    signalId: signal.id,
  };
  params.emit('loop:auto-unstick', {
    loopRunId: params.state.id,
    seq: params.seq,
    attempt: next,
    max: AUTO_UNSTICK_MAX_ATTEMPTS,
    signalId: signal.id,
    message: signal.message,
  });
  return { injected: true, attempts: next };
}

/** Coordinator seam: persist the attempt count, return whether we injected. */
export function runLoopAutoUnstick(params: {
  state: LoopState;
  seq: number;
  verdict: string;
  signals: readonly AutoUnstickSignal[];
  verifyPassed: boolean;
  getAttempts: () => number;
  setAttempts: (count: number) => void;
  emit: (eventName: string, payload: unknown) => boolean;
}): boolean {
  const result = applyLoopAutoUnstickOnStall({
    state: params.state,
    seq: params.seq,
    verdict: params.verdict,
    signals: params.signals,
    verifyPassed: params.verifyPassed,
    attempts: params.getAttempts(),
    emit: params.emit,
  });
  params.setAttempts(result.attempts);
  return result.injected;
}
