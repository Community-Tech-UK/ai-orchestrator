/**
 * L9 — a mass "everything is dead" probe result is a broken probe, not a
 * massacre.
 *
 * Any liveness check that can terminate work has one catastrophic failure mode:
 * the probe itself breaks (the OS refuses process listing, a container pauses,
 * the event loop stalls past the probe's own timeout, a laptop wakes from
 * sleep) and every session in the pass comes back "dead" at once. Acting on
 * that reaps healthy work.
 *
 * agent-orchestrator's reaper answers this with a shape test rather than a
 * per-session one: if a single pass concludes that a large ABSOLUTE number of
 * sessions died AND they are most of the pass, the pass is inconclusive
 * (`ProbeFailed`) and nothing is acted on. Both halves matter — the fraction
 * alone would veto a legitimate "the only two sessions I was watching both
 * finished", and the count alone would let a 5-of-500 real cull look like an
 * outage.
 *
 * **NOT WIRED — no caller yet, and that is the honest state.** This must be in
 * place BEFORE any probe can terminate a loop (plan W2.1 ordering), and as of
 * this change AIO has no such probe pass: the only reaper in the tree is the
 * mobile-gateway websocket heartbeat, which does not touch loops. So there is
 * nothing to guard yet. Ship the guard first, per the plan's ordering; wire it
 * the moment a liveness pass that can act on loops is introduced.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('LoopLivenessProbePolicy');

/** Minimum number of dead verdicts in one pass before the shape test applies. */
export const MASS_DEAD_MIN_SESSIONS = 5;
/** Fraction of the pass that must be dead for the pass to look like an outage. */
export const MASS_DEAD_FRACTION = 0.5;

export type LivenessVerdict = 'alive' | 'dead' | 'unknown';

export interface LivenessProbeResult {
  sessionId: string;
  verdict: LivenessVerdict;
  /** Why the probe concluded what it did. Kept for the audit trail. */
  reason?: string;
}

export interface LivenessPassOutcome {
  /**
   * `false` when the pass looks like a probe outage. Callers must treat an
   * inconclusive pass as "no information" — never as "everything is alive"
   * either, which would suppress a genuine single-session cleanup.
   */
  actionable: boolean;
  /** Sessions the caller may act on. Empty when the pass is inconclusive. */
  actionable_dead: string[];
  deadCount: number;
  total: number;
  reason: string;
}

/**
 * Decide whether a completed probe pass may be acted on.
 *
 * Deliberately pure and total: no clock, no I/O, no throwing. `unknown`
 * verdicts count toward the pass total (they are sessions we looked at) but
 * never toward the dead count — a probe that could not answer is not evidence
 * of death.
 */
export function evaluateLivenessPass(
  results: readonly LivenessProbeResult[],
  options: { minSessions?: number; fraction?: number } = {},
): LivenessPassOutcome {
  const minSessions = options.minSessions ?? MASS_DEAD_MIN_SESSIONS;
  const fraction = options.fraction ?? MASS_DEAD_FRACTION;
  const total = results.length;
  const dead = results.filter((result) => result.verdict === 'dead');
  const deadCount = dead.length;

  if (total === 0) {
    return { actionable: false, actionable_dead: [], deadCount: 0, total: 0, reason: 'empty probe pass' };
  }

  const looksLikeOutage = deadCount >= minSessions && deadCount > total * fraction;
  if (looksLikeOutage) {
    const reason =
      `probe pass reported ${deadCount}/${total} sessions dead — at or above ${minSessions} `
      + `and over ${Math.round(fraction * 100)}% of the pass, so the probe itself is the more `
      + 'likely explanation; treating the pass as inconclusive';
    logger.warn('Liveness probe pass rewritten as ProbeFailed (L9)', { deadCount, total });
    return { actionable: false, actionable_dead: [], deadCount, total, reason };
  }

  return {
    actionable: deadCount > 0,
    actionable_dead: dead.map((result) => result.sessionId),
    deadCount,
    total,
    reason: deadCount > 0
      ? `${deadCount}/${total} sessions dead — within the normal range for a single pass`
      : 'no dead sessions in this pass',
  };
}
