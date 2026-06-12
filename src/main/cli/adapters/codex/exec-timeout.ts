/**
 * Exec-mode timeout types for the Codex adapter. Kept out of the (already
 * large) adapter file so it stays focused on process/IO orchestration.
 */

/**
 * Which phase of the exec-mode lifecycle the timeout fired in.
 * - `startup`: first turn after spawn — short budget to surface auth/config hangs fast
 * - `turn`: subsequent turns — long budget for legitimate long-running work
 */
export type CodexExecPhase = 'startup' | 'turn';

/**
 * Which watchdog killed the exec turn.
 * - `idle`: the process went silent (no stdout/stderr) for the idle budget —
 *   it hung, or one silent stretch outlasted the budget.
 * - `deadline`: the process was still working but ran out of its total
 *   per-attempt budget (`CodexCliConfig.timeout`).
 */
export type CodexTimeoutKind = 'idle' | 'deadline';

/**
 * Error thrown when an exec-mode `codex` child process fails to complete within
 * its budget. Callers (notably the `sendMessage` retry loop) use
 * `instanceof` to distinguish timeouts from transient errors so they don't
 * compound the wait by retrying a hung process.
 *
 * The message is intentionally actionable: it distinguishes "hung silent
 * during startup" (auth/network), "went silent mid-turn", and "ran out of
 * total budget" (raise the operation's configured timeout), and includes the
 * last network-layer error codex reported before dying when there was one.
 */
export class CodexTimeoutError extends Error {
  readonly phase: CodexExecPhase;
  readonly kind: CodexTimeoutKind;
  readonly timeoutMs: number;
  readonly networkErrorCount: number;
  readonly lastNetworkError: string | null;

  constructor(
    phase: CodexExecPhase,
    timeoutMs: number,
    details?: {
      kind?: CodexTimeoutKind;
      networkErrorCount?: number;
      lastNetworkError?: string | null;
      stdoutBytes?: number;
    }
  ) {
    const kind = details?.kind ?? 'idle';
    const networkErrorCount = details?.networkErrorCount ?? 0;
    const lastNetworkError = details?.lastNetworkError ?? null;
    const stdoutBytes = details?.stdoutBytes ?? 0;
    const seconds = Math.round(timeoutMs / 1000);

    let base: string;
    if (kind === 'deadline') {
      base = `Codex exceeded its total deadline of ${timeoutMs}ms (${seconds}s) before finishing — `
        + 'consider raising the configured timeout for this operation '
        + '(e.g. crossModelReviewTimeout for reviews)';
    } else if (stdoutBytes === 0) {
      base = `Codex produced no output for ${timeoutMs}ms during ${phase}`
        + (phase === 'startup' ? ' (possible auth or network hang)' : '');
    } else {
      base = `Codex went silent for ${timeoutMs}ms during ${phase} after ${stdoutBytes} bytes of output`;
    }

    const networkSuffix = networkErrorCount > 0
      ? ` — codex reported ${networkErrorCount} network error${networkErrorCount === 1 ? '' : 's'}`
        + (lastNetworkError ? ` (last: ${lastNetworkError})` : '')
      : '';
    super(`${base}${networkSuffix}`);
    this.name = 'CodexTimeoutError';
    this.phase = phase;
    this.kind = kind;
    this.timeoutMs = timeoutMs;
    this.networkErrorCount = networkErrorCount;
    this.lastNetworkError = lastNetworkError;
  }
}
