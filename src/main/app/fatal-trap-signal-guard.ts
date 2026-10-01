/**
 * Keep Chromium's fatal-error trap fatal.
 *
 * On arm64 macOS a Chromium/V8 fatal error (`LOG(FATAL)`, `CHECK`,
 * `IMMEDIATE_CRASH`) ends in a `brk` instruction, which the kernel delivers as
 * SIGTRAP. Normally that kills the process. But any JS `process.on('SIGTRAP')`
 * listener makes libuv install a C handler that only queues the signal for the
 * event loop and returns — and returning from a `brk` trap re-executes the same
 * `brk`. The main thread then spins in that handler forever: 100% CPU, "Not
 * Responding", no crash report, and SIGTERM ignored because it waits on the same
 * wedged event loop. Only SIGKILL ends it.
 *
 * `when-exit` (electron-store → conf → atomically → when-exit) registers exactly
 * such a listener at import time. A JS listener can never usefully observe a
 * real trap — it only runs once the event loop turns, which a trapped main
 * thread never does — so this guard strips every SIGTRAP listener, now and
 * whenever one is added later, to restore the default terminate action.
 *
 * Install it in every Electron process whose code can load `when-exit`: the
 * main process (main-process-entry.ts, before ./index loads) and the utility
 * processes that load electron-store (context-worker-main.ts,
 * codebase-indexing-lane-main.ts), where it runs after their imports and
 * relies on stripping the listeners already registered.
 */

const FATAL_TRAP_SIGNAL = 'SIGTRAP';

type Listener = (...args: unknown[]) => void;

export type SignalListenerTarget = Pick<NodeJS.EventEmitter, 'listeners' | 'removeListener' | 'on'>;

// Idempotent per target. The mark lives ON the target under a registry symbol,
// not in module state, because vi.resetModules() re-evaluates this module while
// `process` stays the same object — a module-level set would forget and stack
// another `newListener` hook on every re-import.
const GUARD_INSTALLED = Symbol.for('harness.fatalTrapSignalGuard');

export interface FatalTrapSignalGuardOptions {
  /** Test seam; defaults to `process`. */
  target?: SignalListenerTarget;
  /**
   * `newListener` fires BEFORE the listener is stored, so removal has to be
   * deferred until after the registering call returns.
   */
  defer?: (callback: () => void) => void;
}

export function installFatalTrapSignalGuard(options: FatalTrapSignalGuardOptions = {}): void {
  const target: SignalListenerTarget = options.target ?? process;
  const defer = options.defer ?? ((callback: () => void) => process.nextTick(callback));
  const marked = target as SignalListenerTarget & { [GUARD_INSTALLED]?: true };
  if (marked[GUARD_INSTALLED]) return;
  marked[GUARD_INSTALLED] = true;

  for (const listener of target.listeners(FATAL_TRAP_SIGNAL)) {
    target.removeListener(FATAL_TRAP_SIGNAL, listener as Listener);
  }

  target.on('newListener', (event: string | symbol, listener: Listener) => {
    if (event !== FATAL_TRAP_SIGNAL) return;
    defer(() => {
      target.removeListener(FATAL_TRAP_SIGNAL, listener);
    });
  });
}
