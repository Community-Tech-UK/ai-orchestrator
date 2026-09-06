/**
 * N7 — record how the process was killed, not just that it stopped.
 *
 * `shutdown.ndjson` already records shutdown TRIGGERS the app raises itself
 * (`window-all-closed`, `before-quit`, a failed single-instance lock). What it
 * cannot record is the case that actually leaves people guessing: something
 * outside the app killed it. There are no signal handlers at all today, so a
 * SIGTERM from a supervisor, a Ctrl-C in a terminal, and an OOM kill are
 * indistinguishable after the fact — they simply leave no line.
 *
 * Everything here must be SYNCHRONOUS. The process is being torn down; an async
 * write is a write that does not happen.
 *
 * Scope: the `ps` walk the plan also mentions is NOT implemented. Spawning a
 * child process during signal teardown is unreliable exactly when it matters,
 * and a forensic record that sometimes silently fails is worse than a small one
 * that always lands. The signal and the parent pid are the reliable half.
 */

export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

/** Signals worth recording. SIGKILL cannot be trapped and is absent on purpose. */
export const TRAPPED_SHUTDOWN_SIGNALS: readonly ShutdownSignal[] = [
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
];

export interface SignalProbe {
  pid: number;
  /**
   * The parent process. This is the single most useful field: it distinguishes
   * "my supervisor restarted me" from "a human pressed Ctrl-C in a shell" from
   * "launchd/systemd stopped me".
   */
  ppid: number;
  uptimeSeconds: number;
}

export interface ShutdownSignalRecord {
  signal: ShutdownSignal;
  pid: number;
  ppid: number;
  uptimeSeconds: number;
  /** Plain-language reading of the signal, so a log reader need not know Unix. */
  likelyCause: string;
  observedAt: number;
}

/**
 * A plain-language guess, labelled as a guess.
 *
 * Deliberately hedged: the signal narrows the cause, it does not prove it. A
 * confident wrong attribution in a forensic log sends the next investigation
 * the wrong way, which is worse than saying "usually".
 */
export function likelyCauseOf(signal: ShutdownSignal): string {
  switch (signal) {
    case 'SIGINT':
      return 'usually Ctrl-C in the terminal that launched it';
    case 'SIGTERM':
      return 'usually a supervisor, package manager, or `kill` asking it to stop';
    case 'SIGHUP':
      return 'usually the controlling terminal closing';
    case 'SIGQUIT':
      return 'usually a deliberate quit-with-core request';
  }
}

export function buildShutdownSignalRecord(
  signal: ShutdownSignal,
  probe: SignalProbe,
  now: number = Date.now(),
): ShutdownSignalRecord {
  return {
    signal,
    pid: probe.pid,
    ppid: probe.ppid,
    uptimeSeconds: Math.round(probe.uptimeSeconds),
    likelyCause: likelyCauseOf(signal),
    observedAt: now,
  };
}

export interface InstallSignalProbesOptions {
  /** Synchronous writer. Must not defer. */
  write: (record: ShutdownSignalRecord) => void;
  /** Test seam for the process facts. */
  readProbe?: () => SignalProbe;
  on?: (signal: ShutdownSignal, handler: () => void) => void;
  /** Test seam for deregistering our own listener before re-raising. */
  off?: (signal: ShutdownSignal, handler: () => void) => void;
  /** Test seam for the re-raise that restores default termination. */
  reRaise?: (signal: ShutdownSignal) => void;
  signals?: readonly ShutdownSignal[];
}

/**
 * Register handlers that record the signal and then let the process die.
 *
 * **Re-raising is mandatory, not tidiness.** Installing ANY listener for
 * SIGINT/SIGTERM removes Node's default terminate-on-signal action. A handler
 * that only records therefore keeps the process alive: a supervisor's SIGTERM
 * stops working, every restart escalates to SIGKILL — which cannot be trapped
 * and so is never recorded — and the feature destroys the very forensic trail
 * it exists to create. The first version of this file did exactly that, and its
 * own comment claimed the opposite.
 *
 * So each handler records, removes ITSELF (not every listener — other code may
 * legitimately have its own), and re-sends the signal so the default action now
 * applies. If another listener is still registered, that listener owns the
 * outcome, which is correct: this module's job is to observe, not to override.
 */
export function installShutdownSignalProbes(options: InstallSignalProbesOptions): void {
  const readProbe = options.readProbe
    ?? (() => ({ pid: process.pid, ppid: process.ppid, uptimeSeconds: process.uptime() }));
  const on = options.on
    ?? ((signal: ShutdownSignal, handler: () => void) => { process.on(signal, handler); });
  const off = options.off
    ?? ((signal: ShutdownSignal, handler: () => void) => { process.off(signal, handler); });
  const reRaise = options.reRaise
    ?? ((signal: ShutdownSignal) => { process.kill(process.pid, signal); });

  for (const signal of options.signals ?? TRAPPED_SHUTDOWN_SIGNALS) {
    const handler = (): void => {
      try {
        options.write(buildShutdownSignalRecord(signal, readProbe()));
      } catch {
        // A forensic record must never be the reason a shutdown hangs.
      }
      try {
        off(signal, handler);
        reRaise(signal);
      } catch {
        // If re-raising somehow fails, do not leave the process wedged.
        process.exit(0);
      }
    };
    on(signal, handler);
  }
}
