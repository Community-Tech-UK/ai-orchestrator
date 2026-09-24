/**
 * Shared "resume a parked loop" sequence.
 *
 * A loop can be parked in two ways that outlive the process that started it:
 * `paused` (operator pause, or a boot-time running→paused reconcile) and
 * `provider-limit` with `endedAt === null` (usage-aware throttling). Both are
 * resumable, but only while the coordinator holds the state in memory —
 * after an app restart the state lives in the checkpoint table and has to be
 * re-hydrated first.
 *
 * That two-step dance used to live only in the `LOOP_RESUME` IPC handler,
 * which made the renderer the single surface able to restart a parked loop.
 * It is extracted here so the IPC handler and the `aio-mcp loop resume` CLI
 * share one implementation and cannot drift.
 */

import type { LoopState } from '../../shared/types/loop.types';
import type { LoopCheckpoint } from './loop-checkpoint';

export interface LoopResumeCoordinator {
  resumeLoop(loopRunId: string): boolean;
  getLoop(loopRunId: string): LoopState | undefined;
  restoreLoopFromCheckpoint(checkpoint: LoopCheckpoint): Promise<LoopState>;
}

export interface LoopResumeStore {
  getCheckpoint(loopRunId: string): LoopCheckpoint | null;
  upsertRun(state: LoopState): void;
}

export interface LoopResumeOutcome {
  /** True when the loop is running again. */
  ok: boolean;
  /** Post-attempt coordinator snapshot; undefined when nothing was hydrated. */
  state: LoopState | undefined;
  /** True when the loop had to be re-hydrated from its stored checkpoint. */
  restoredFromCheckpoint: boolean;
  /** Present only when `ok` is false: why the loop could not be resumed. */
  reason?: string;
}

/**
 * Resume `loopRunId`, re-hydrating it from its checkpoint when the coordinator
 * has no live state for it.
 *
 * Restore failures (a missing isolated worktree, a terminal provider-limit
 * checkpoint) throw, matching `restoreLoopFromCheckpoint` — those are faults
 * the caller must surface, not a plain "not resumable" answer.
 */
export async function resumeLoopRun(
  coordinator: LoopResumeCoordinator,
  store: LoopResumeStore,
  loopRunId: string,
): Promise<LoopResumeOutcome> {
  let ok = coordinator.resumeLoop(loopRunId);
  let state = coordinator.getLoop(loopRunId);
  let restoredFromCheckpoint = false;

  if (!ok && !state) {
    const checkpoint = store.getCheckpoint(loopRunId);
    if (!checkpoint) {
      return {
        ok: false,
        state: undefined,
        restoredFromCheckpoint: false,
        reason: `No loop ${loopRunId} is running and no stored checkpoint exists for it.`,
      };
    }
    if (!isRestorableCheckpointState(checkpoint.state)) {
      // A terminal loop is answered like a live one (LT-642); the restore path
      // would only throw its own internal "non-paused checkpoint" error.
      return {
        ok: false,
        state: undefined,
        restoredFromCheckpoint: false,
        reason: notResumableReason(loopRunId, checkpoint.state),
      };
    }
    await coordinator.restoreLoopFromCheckpoint(checkpoint);
    restoredFromCheckpoint = true;
    ok = coordinator.resumeLoop(loopRunId);
    state = coordinator.getLoop(loopRunId);
  }

  if (state) {
    try {
      store.upsertRun(state);
    } catch {
      // Best-effort: the loop is already running again in memory, and the
      // next iteration checkpoint re-persists it.
    }
  }

  if (ok) {
    return { ok: true, state, restoredFromCheckpoint };
  }
  return {
    ok: false,
    state,
    restoredFromCheckpoint,
    reason: notResumableReason(loopRunId, state),
  };
}

/**
 * Mirrors `restoreLoopFromCheckpoint`: a crash leaves `running`, which the
 * restore reconciles to `paused`; only `paused` and a provider-limit park with
 * no end time come back.
 */
function isRestorableCheckpointState(state: LoopState): boolean {
  return state.status === 'paused'
    || state.status === 'running'
    || (state.status === 'provider-limit' && state.endedAt == null);
}

function notResumableReason(loopRunId: string, state: LoopState | undefined): string {
  if (!state) {
    return `Loop ${loopRunId} could not be resumed.`;
  }
  if (state.status === 'running') {
    return `Loop ${loopRunId} is already running.`;
  }
  if (state.status === 'provider-limit' && state.endedAt != null) {
    return `Loop ${loopRunId} ended on a provider limit with no resume window, `
      + 'so it is terminal. Start a new loop instead.';
  }
  return `Loop ${loopRunId} is ${state.status}, which is terminal. `
    + 'Only paused loops and provider-limit loops parked with no end time can resume.';
}
