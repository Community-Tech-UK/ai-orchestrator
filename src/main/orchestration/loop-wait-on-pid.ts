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
 * Wired from `loop-spawn-verify.ts` on verify timeout: kill the spawn *and*
 * its descendants (the login-shell wrapper otherwise leaves npm/vitest alive
 * with `ppid=1`), then wait here before the next iteration starts.
 */

import { execFileSync } from 'node:child_process';
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

/** Bound for reaping a SIGKILL'd verify tree before the next iteration. */
export const VERIFY_REAP_TIMEOUT_MS = 30_000;

export interface KillProcessTreeDeps {
  listChildren?: (pid: number) => number[];
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * SIGKILL `pid` and every descendant. A login-shell verify (`zsh -lc npm …`)
 * dies on `child.kill()` while npm/vitest keep running as orphans — that is
 * what blew this loop's 600s coordinator timeout.
 */
export function killProcessTree(
  pid: number | null | undefined,
  deps: KillProcessTreeDeps = {},
): void {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32' && !deps.listChildren) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5_000 });
    } catch {
      // already gone
    }
    return;
  }
  const listChildren = deps.listChildren ?? listChildPids;
  const kill = deps.kill ?? ((p, signal) => { process.kill(p, signal); });
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of listChildren(current)) {
      if (!seen.has(child)) stack.push(child);
    }
  }
  for (const target of seen) {
    try {
      kill(target, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function listChildPids(pid: number): number[] {
  if (process.platform === 'win32') {
    return [];
  }
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    });
    return out
      .split(/\s+/)
      .map((part) => Number(part))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}
