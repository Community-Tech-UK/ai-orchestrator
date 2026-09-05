/**
 * L3 — alive ≠ advancing ≠ waiting-on-build ≠ stalled ≠ zombie.
 *
 * The loop currently answers one question ("is the turn still running?") and
 * uses it for several different decisions. That conflation is what makes a
 * ten-minute test run look identical to a wedged child, and what let a wedged
 * child that still emitted heartbeats run to a wall-clock cap.
 *
 * This is storybloq's `health-model` shape: independent probes, each of which
 * may answer `null` (could not tell), reduced into ONE state. Three rules carry
 * the design:
 *
 *  1. **A failed probe is `null`, never `false`.** "I could not check" is not
 *     "it is dead". A mid-compaction drop, a paused container, or an event-loop
 *     stall all produce unanswerable probes, and treating those as death is the
 *     mass-reaping failure L9 guards against at the pass level.
 *  2. **`alive` is an epoch, not a boolean.** Knowing a process existed at
 *     11:04 is different from knowing it exists now; a stale observation must
 *     decay rather than be reused as fact.
 *  3. **`waiting-on-build` is not stalled.** When the phase says a check is
 *     running (L4) or a subprocess is alive, stall counters HOLD. `tura`'s
 *     `waiting_first_token` belongs in the same bucket: a turn that has not
 *     produced its first token yet is starting, not stuck.
 *
 * Advisory by construction: nothing here terminates a loop. It classifies, and
 * the caller decides. Wiring a terminal decision to it requires L9's pass
 * policy to be in place first.
 *
 * **NOT WIRED — its inputs do not exist yet.** `processAliveAt` and
 * `subprocessAlive` need per-turn PID tracking that neither the child invoker
 * nor the verify spawner records today, and AIO's stall detection runs at the
 * ITERATION SEAL rather than during a turn, which is where this reducer earns
 * its keep. Wiring it means adding that tracking first; inventing the probes
 * here would mean feeding the reducer values nobody measured.
 */

import type { LoopInferredPhase } from '../../shared/types/loop-health.types';

export type LoopHealthState =
  /** The turn is producing observable work. */
  | 'advancing'
  /** A check/build is running; the guide is not advancing and should not be. */
  | 'waiting-on-build'
  /** The turn has started but produced nothing yet. Not stuck — starting. */
  | 'waiting-first-token'
  /** Observably alive but not advancing for longer than the stall window. */
  | 'stalled'
  /** The process is gone while the loop still believes a turn is in flight. */
  | 'zombie'
  /** Probes could not answer. Hold everything; act on nothing. */
  | 'unknown';

export interface LoopHealthProbes {
  /**
   * Epoch ms the child process was last OBSERVED alive, `null` when the probe
   * could not answer, `undefined` when the probe positively found no process.
   * The three cases are deliberately distinct — see rule 1.
   */
  processAliveAt: number | null | undefined;
  /** Epoch ms of the last tool call / command line seen on the stream. */
  lastActivityAt: number | null;
  /** Epoch ms the current turn began. */
  turnStartedAt: number;
  /** L4's advisory phase for the current turn, when one has been inferred. */
  phase: LoopInferredPhase | null;
  /** A verify/build subprocess the loop itself spawned is still running. */
  subprocessAlive: boolean;
  /** Wall-clock now. Injected so the reducer stays pure. */
  now: number;
}

export interface LoopHealthAssessment {
  state: LoopHealthState;
  /** Human-readable reason. Goes on the HUD, so it must be specific. */
  reason: string;
  /**
   * True while stall counters must NOT advance. Distinct from the state so a
   * caller can hold counters without having to re-derive the reason.
   */
  holdStallCounters: boolean;
}

/** Beyond this with no observable activity, a live turn counts as stalled. */
export const STALL_WINDOW_MS = 5 * 60 * 1000;
/** An `alive` observation older than this has decayed back to unknown. */
export const ALIVE_OBSERVATION_TTL_MS = 60 * 1000;

export function assessLoopHealth(probes: LoopHealthProbes): LoopHealthAssessment {
  const hold = (state: LoopHealthState, reason: string): LoopHealthAssessment =>
    ({ state, reason, holdStallCounters: true });

  // Rule 1: an unanswerable process probe stops everything. It is never
  // evidence of death, and it is never evidence of life either.
  if (probes.processAliveAt === null) {
    return hold('unknown', 'process liveness probe could not answer — holding, not concluding');
  }

  // A positively-absent process while a turn is in flight is the zombie case.
  // This is the only state that says something is genuinely wrong.
  if (probes.processAliveAt === undefined) {
    return {
      state: 'zombie',
      reason: 'no child process found while the loop still believes a turn is in flight',
      holdStallCounters: false,
    };
  }

  // Rule 2: a stale liveness observation has decayed. Believing an old epoch is
  // how a session that died five minutes ago keeps reading as healthy.
  if (probes.now - probes.processAliveAt > ALIVE_OBSERVATION_TTL_MS) {
    return hold('unknown', 'last liveness observation is stale — re-probe before concluding anything');
  }

  // Rule 3: a running check is the loop working, not the loop stuck.
  if (probes.subprocessAlive) {
    return hold('waiting-on-build', 'a verify/build subprocess the loop spawned is still running');
  }
  if (probes.phase === 'verifying') {
    return hold('waiting-on-build', 'the child is running checks');
  }

  // A turn that has produced nothing yet is starting, not stuck (tura).
  if (probes.lastActivityAt === null) {
    const sinceStart = probes.now - probes.turnStartedAt;
    return sinceStart <= STALL_WINDOW_MS
      ? hold('waiting-first-token', 'the turn has not produced its first observable activity yet')
      : {
          state: 'stalled',
          reason: `no observable activity in the ${Math.round(sinceStart / 1000)}s since the turn began`,
          holdStallCounters: false,
        };
  }

  const idleMs = probes.now - probes.lastActivityAt;
  if (idleMs > STALL_WINDOW_MS) {
    return {
      state: 'stalled',
      reason: `alive but no tool call or command for ${Math.round(idleMs / 1000)}s`,
      holdStallCounters: false,
    };
  }

  return {
    state: 'advancing',
    reason: probes.phase ? `advancing (${probes.phase})` : 'advancing',
    holdStallCounters: false,
  };
}
