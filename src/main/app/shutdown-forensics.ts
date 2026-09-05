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
  signals?: readonly ShutdownSignal[];
}

/**
 * Register handlers that record the signal and then get out of the way.
 *
 * They do NOT exit or swallow: adding a handler for a signal suppresses Node's
 * default termination, so the handler must not become the reason the app fails
 * to die. Recording is all it does; existing quit paths still run.
 */
export function installShutdownSignalProbes(options: InstallSignalProbesOptions): void {
  const readProbe = options.readProbe
    ?? (() => ({ pid: process.pid, ppid: process.ppid, uptimeSeconds: process.uptime() }));
  const on = options.on
    ?? ((signal: ShutdownSignal, handler: () => void) => { process.on(signal, handler); });

  for (const signal of options.signals ?? TRAPPED_SHUTDOWN_SIGNALS) {
    on(signal, () => {
      try {
        options.write(buildShutdownSignalRecord(signal, readProbe()));
      } catch {
        // A forensic record must never be the reason a shutdown hangs.
      }
    });
  }
}
