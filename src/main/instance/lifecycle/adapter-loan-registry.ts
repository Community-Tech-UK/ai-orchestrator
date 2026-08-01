/**
 * Adapter-loan registry (LT-020).
 *
 * A `same-session` loop does not spawn its own CLI — it **borrows the parent
 * instance's live adapter** (`default-invokers.ts`, `borrowedFromInstance`). The
 * instance is then the loop's execution runtime, and its `status` alone stops
 * being a trustworthy answer to "is it safe to respawn this session?": the
 * status can read input-waiting in the gap between one borrowed turn ending and
 * the loop coordinator dispatching the next, while the iteration as a whole is
 * still in flight.
 *
 * Before this registry, a queued provider/model swap applied in exactly that gap
 * would SIGTERM the borrowed CLI mid-iteration. The loop saw an unexplained
 * `process_exit`, classified it as a degraded iteration with unprovable
 * workspace state, and terminated as `completed-needs-review`.
 *
 * The registry is a module-level singleton on purpose: the borrower lives in
 * `src/main/orchestration` and the consumer in `src/main/instance`, and
 * threading a dependency between those two through the whole loop-invoker
 * payload would be far more invasive than the problem warrants.
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('AdapterLoanRegistry');

/** Opaque handle returned by {@link beginAdapterLoan}. */
export interface AdapterLoan {
  readonly instanceId: string;
  readonly loopRunId: string;
  /**
   * Unique per *invocation*, not per loop run. Two invocations of the same
   * `loopRunId` genuinely overlap when the child invoker times out its own
   * promise while the listener is still awaiting the CLI: the coordinator
   * retries the same seq, and the retry borrows the same live adapter. Keying
   * by `loopRunId` would let the timed-out attempt's release free a loan the
   * retry still needs — re-opening LT-020 on exactly the path it was found on.
   */
  readonly token: string;
}

/** instanceId → active loan tokens. A set, not a flag: an unbalanced release
 *  must not free an instance another loan still holds. */
const loans = new Map<string, Set<string>>();

/** Called when a loan is released, so a queued change can apply at the real
 *  iteration boundary rather than waiting for an unrelated later transition. */
const releaseListeners = new Set<(instanceId: string) => void>();

let nextLoanSeq = 0;

/** token → when it was claimed, so a wedged loan is diagnosable rather than silent. */
const loanStartedAt = new Map<string, number>();

/**
 * How long a single loop iteration may plausibly hold the adapter before the
 * loan looks wedged. Deliberately well clear of the 30-minute *default*
 * iteration timeout — a loop configured with a longer one must not trip this on
 * legitimate work — while still far short of "forever".
 */
const STALE_LOAN_WARN_MS = 3 * 60 * 60 * 1000;

export function beginAdapterLoan(instanceId: string, loopRunId: string): AdapterLoan {
  const token = `${loopRunId}#${++nextLoanSeq}`;
  const held = loans.get(instanceId) ?? new Set<string>();
  held.add(token);
  loans.set(instanceId, held);
  loanStartedAt.set(token, Date.now());
  logger.info('Adapter loaned to loop iteration', { instanceId, loopRunId, holders: held.size });
  return { instanceId, loopRunId, token };
}

/** Age of the oldest loan on this instance, or 0 when none is held. */
export function oldestLoanAgeMs(instanceId: string): number {
  const held = loans.get(instanceId);
  if (!held?.size) return 0;
  let oldest = Infinity;
  for (const token of held) oldest = Math.min(oldest, loanStartedAt.get(token) ?? Date.now());
  return oldest === Infinity ? 0 : Date.now() - oldest;
}

export function endAdapterLoan(loan: AdapterLoan | undefined): void {
  if (!loan) return;
  const held = loans.get(loan.instanceId);
  if (!held) return;
  held.delete(loan.token);
  loanStartedAt.delete(loan.token);
  if (held.size > 0) {
    loans.set(loan.instanceId, held);
    return;
  }
  loans.delete(loan.instanceId);
  logger.info('Adapter loan released', { instanceId: loan.instanceId, loopRunId: loan.loopRunId });
  for (const listener of releaseListeners) {
    try {
      listener(loan.instanceId);
    } catch (error) {
      logger.warn('Adapter-loan release listener failed', {
        instanceId: loan.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** True while a loop iteration is executing on this instance's adapter. */
export function isAdapterOnLoan(instanceId: string): boolean {
  return (loans.get(instanceId)?.size ?? 0) > 0;
}

/** Loop runs currently borrowing this instance's adapter. */
export function loanHoldersFor(instanceId: string): readonly string[] {
  return [...(loans.get(instanceId) ?? [])];
}

export function onAdapterLoanReleased(listener: (instanceId: string) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

/**
 * Thrown when a runtime change is refused because a loop iteration is running
 * on the instance's adapter. Identifiable on purpose: this is a *retry later*
 * signal, never a permanent failure, and callers that queue must be able to
 * tell the two apart without matching on message text.
 */
export class AdapterOnLoanError extends Error {
  readonly retryable = true;

  constructor(instanceId: string) {
    super('This session is running a loop iteration right now. '
      + 'The change will be applied when the iteration finishes.');
    this.name = 'AdapterOnLoanError';
    this.instanceId = instanceId;
  }

  readonly instanceId: string;
}

export function isAdapterOnLoanError(error: unknown): error is AdapterOnLoanError {
  return error instanceof AdapterOnLoanError;
}

/**
 * Refuse a change that would tear down an adapter a loop is mid-iteration on.
 *
 * Scoped to a **live** adapter on purpose: once the CLI has already exited
 * there is nothing left to SIGTERM, and blocking then would defeat provider
 * failover — whose whole job is to escape a dead provider, and the reason
 * `error` is a model-switch-allowed status in the first place.
 *
 * Call this both on entry *and* immediately before the terminate: a provider
 * swap awaits CLI availability in between, and on a cold detection cache that
 * probe takes seconds — long enough for the loop to start its next iteration.
 */
export function assertAdapterNotOnLoan(
  instanceId: string,
  hasLiveAdapter: boolean,
): void {
  if (!hasLiveAdapter) return;
  if (!isAdapterOnLoan(instanceId)) return;
  warnIfLoanLooksWedged(instanceId);
  throw new AdapterOnLoanError(instanceId);
}

/**
 * Log once a held loan has outlived any plausible iteration — that means the
 * invocation never settled and the instance is now silently un-swappable.
 *
 * Exported because the queue's park path never reaches
 * {@link assertAdapterNotOnLoan}: it pre-checks the loan and parks quietly, so
 * without calling this the wedged case the user actually hits (a pending chip
 * that never lands) would leave no trace in the log at all.
 */
export function warnIfLoanLooksWedged(instanceId: string): void {
  const ageMs = oldestLoanAgeMs(instanceId);
  if (ageMs <= STALE_LOAN_WARN_MS) return;
  logger.warn('A loop adapter loan looks wedged; runtime changes are parked behind it', {
    instanceId,
    ageMs,
    holders: loanHoldersFor(instanceId),
  });
}

export function _resetAdapterLoansForTesting(): void {
  loans.clear();
  loanStartedAt.clear();
  releaseListeners.clear();
}
