/**
 * L5 — wait on a real process instead of starting the next iteration.
 *
 * When the child or a verify spawn still has a live PID, the loop's cheapest
 * correct move is to wait for that process, not to buy another turn. Hermes
 * calls this `wait_on_pid`; the discipline that makes it safe is narrow:
 *
 *  - **A dead PID releases immediately.** Waiting on a corpse is a hang.
 *  - **An unknown PID fails open.** No PID, a PID we cannot signal, or a
 *    permission error means "carry on" — never "block". A wait primitive that
 *    can block forever on bad input is worse than no wait primitive.
 *  - **Bounded.** Even a live process releases the wait at `timeoutMs` so a
 *    genuinely wedged subprocess cannot hold the loop indefinitely; the caller
 *    then makes its own decision with the timeout as evidence.
 *
 * `process.kill(pid, 0)` is the liveness check: it signals nothing and throws
 * `ESRCH` when the process is gone. `EPERM` means the process EXISTS but
 * belongs to another user — alive, not absent.
 *
 * **NOT WIRED — but the premise is narrower than "cannot happen".** On the
 * happy path there is nothing to wait on: `invokeLoopChildIteration` resolves
 * only via the adapter callback, and `spawnVerify` resolves on the child's
 * `close` event. There IS one real case, and it is where this belongs when it
 * is wired: on a verify TIMEOUT, `spawnVerify` sends `SIGKILL` and resolves
 * immediately WITHOUT awaiting `close`, and the signal reaches the shell rather
 * than necessarily its grandchildren — so the loop can start the next iteration
 * while a build or test process from the previous one is still alive, competing
 * for the same ports, lockfiles and CPU.
 *
 * Wiring that safely needs the timeout path to surface the pid it killed, which
 * it does not today. Until then this stays unused rather than guessing at a pid.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('LoopWaitOnPid');

/** How often liveness is re-checked while waiting. */
export const PID_POLL_INTERVAL_MS = 500;

export type PidLiveness = 'alive' | 'gone' | 'unknown';

/**
 * Is this PID still running? Deliberately three-valued: `unknown` is what an
 * unusable PID or an unexpected error produces, and callers must fail open on
 * it rather than treat it as either answer.
 */
export function probePidLiveness(
  pid: number | null | undefined,
  kill: (pid: number, signal: number) => void = (p, s) => { process.kill(p, s); },
): PidLiveness {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ESRCH') return 'gone';
    // EPERM means the process exists but is owned by someone else.
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export type WaitOnPidOutcome = 'exited' | 'timeout' | 'skipped';

export interface WaitOnPidResult {
  outcome: WaitOnPidOutcome;
  waitedMs: number;
  reason: string;
}

/**
 * Wait for `pid` to exit, up to `timeoutMs`. Returns immediately with
 * `skipped` when the PID is unusable or already gone — the fail-open path.
 */
export async function waitOnPid(args: {
  pid: number | null | undefined;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Injected for tests; defaults to the real clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (pid: number | null | undefined) => PidLiveness;
  /** Abort the wait early (loop cancelled, operator stop). */
  isCancelled?: () => boolean;
}): Promise<WaitOnPidResult> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const probe = args.probe ?? ((pid) => probePidLiveness(pid));
  const pollIntervalMs = Math.max(1, args.pollIntervalMs ?? PID_POLL_INTERVAL_MS);
  const startedAt = now();

  const initial = probe(args.pid);
  if (initial !== 'alive') {
    return {
      outcome: 'skipped',
      waitedMs: 0,
      reason: initial === 'gone'
        ? 'process had already exited'
        : 'no usable pid to wait on — continuing rather than blocking',
    };
  }

  for (;;) {
    if (args.isCancelled?.()) {
      return { outcome: 'skipped', waitedMs: now() - startedAt, reason: 'wait cancelled' };
    }
    const elapsed = now() - startedAt;
    if (elapsed >= args.timeoutMs) {
      logger.info('Wait-on-pid timed out with the process still alive', { pid: args.pid, elapsed });
      return {
        outcome: 'timeout',
        waitedMs: elapsed,
        reason: `process still alive after ${Math.round(elapsed / 1000)}s`,
      };
    }
    await sleep(Math.min(pollIntervalMs, args.timeoutMs - elapsed));
    const liveness = probe(args.pid);
    if (liveness === 'gone') {
      return { outcome: 'exited', waitedMs: now() - startedAt, reason: 'process exited' };
    }
    // `unknown` mid-wait is a probe failure, not an exit. Fail open rather than
    // claim the process finished — the caller would otherwise act on a lie.
    if (liveness === 'unknown') {
      return {
        outcome: 'skipped',
        waitedMs: now() - startedAt,
        reason: 'liveness probe stopped answering — continuing rather than assuming an exit',
      };
    }
  }
}
