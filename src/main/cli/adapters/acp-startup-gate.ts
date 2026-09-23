/**
 * Serialises ACP agent process startups that must not overlap.
 *
 * OpenCode 1.18 opens its shared SQLite database with `PRAGMA journal_mode =
 * WAL` before it sets `busy_timeout`, so a second `opencode acp` that opens the
 * database in the same instant gets `SQLITE_BUSY` and exits 1 ("database is
 * locked") before answering `initialize`. Once started, processes share the
 * database safely. A gate held from spawn until `initialize` answers removes
 * the race between AIO's own sessions (parallel loop children, sessions
 * restored together at app start).
 */

export type AcpStartupGate = () => Promise<() => void>;

/** A hung start never blocks the queue for longer than this. */
const DEFAULT_MAX_HOLD_MS = 30_000;

export function createAcpStartupGate(maxHoldMs = DEFAULT_MAX_HOLD_MS): AcpStartupGate {
  let tail: Promise<void> = Promise.resolve();
  return async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => held);
    await previous;
    const timer = setTimeout(release, maxHoldMs);
    timer.unref?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      release();
    };
  };
}
