/**
 * Loop/session provider divergence notice (LT-020).
 *
 * A `same-session` loop executes on the parent instance's adapter but keeps its
 * OWN configured provider (`LoopState.config.provider`). Swapping the session's
 * provider therefore leaves the header badge saying one thing while the loop
 * carries on spending against another.
 *
 * The decision (2026-08-01) was to keep them decoupled rather than propagate or
 * refuse:
 *
 *  - **Propagating** would silently re-provider an unattended long-running job,
 *    changing its cost and behaviour mid-flight from a single picker click.
 *  - **Refusing** the swap would break a legitimate action on a session the user
 *    owns, just because a loop happens to be running.
 *  - So the loop keeps its provider — and we *say so*. The defect was never that
 *    they diverge; it was that nothing told the user they had.
 *
 * The coordinator is reached through a lazy require: loop state lives in
 * `src/main/orchestration`, and the reconciler must not depend on it statically.
 */

import { getLogger } from '../../logging/logger';
import { isActiveLoopRuntimeState } from '../../orchestration/loop-runtime-status';
import type { LoopState } from '../../../shared/types/loop.types';

const logger = getLogger('LoopProviderDivergence');

interface ActiveLoopLike {
  chatId?: string;
  status?: LoopState['status'];
  endedAt?: number | null;
  config?: { provider?: string };
}

/**
 * "Still attached to this session" uses the canonical predicate rather than a
 * hand-written status list. An earlier local list carried two statuses that do
 * not exist in `LoopStatus` and — worse — omitted `provider-limit`, which is
 * precisely the parked state that makes a user reach for the provider picker in
 * the first place.
 */
function isLiveLoop(candidate: ActiveLoopLike): boolean {
  if (!candidate.status) return false;
  return isActiveLoopRuntimeState({
    status: candidate.status,
    endedAt: candidate.endedAt ?? null,
  });
}

/** The real coordinator, reached lazily so this module stays importable from
 *  `src/main/instance` without a static dependency on orchestration. */
function defaultReadActiveLoops(): ActiveLoopLike[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLoopCoordinator } = require('../../orchestration/loop-coordinator') as {
    getLoopCoordinator: () => { getActiveLoops?: () => ActiveLoopLike[] };
  };
  return getLoopCoordinator().getActiveLoops?.() ?? [];
}

/**
 * A user-facing sentence when a swap has just diverged a live loop's provider
 * from its session's, or `null` when there is nothing to say.
 */
export function describeLoopProviderDivergence(
  instanceId: string,
  newProvider: string,
  /** Injectable for tests; defaults to the real coordinator via lazy require. */
  readActiveLoops: () => ActiveLoopLike[] = defaultReadActiveLoops,
): string | null {
  let loops: ActiveLoopLike[];
  try {
    loops = readActiveLoops();
  } catch (error) {
    // Never let a notice break a runtime change that has already been applied.
    logger.warn('Could not read loop state for a provider-divergence notice', {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const loop = loops.find(
    (candidate) =>
      candidate.chatId === instanceId && isLiveLoop(candidate),
  );
  const loopProvider = loop?.config?.provider;
  // Diagnostic: this notice is the only thing standing between the user and a
  // session whose badge disagrees with the loop spending their quota, so when
  // it decides to stay quiet, say why.
  logger.debug('Loop provider divergence check', {
    instanceId,
    newProvider,
    activeLoops: loops.length,
    matched: Boolean(loop),
    loopProvider: loopProvider ?? null,
    candidates: loops.map((c) => `${c.chatId ?? '?'}:${c.status ?? '?'}`),
  });
  if (!loopProvider || loopProvider === newProvider) return null;

  return (
    `[System: This session is now on ${newProvider}, but the loop running on it stays on `
    + `${loopProvider} — a loop keeps the provider it was started with. New messages you send `
    + `go to ${newProvider}; the loop's own iterations continue on ${loopProvider}. Stop and `
    + `restart the loop if you want it moved.]`
  );
}
