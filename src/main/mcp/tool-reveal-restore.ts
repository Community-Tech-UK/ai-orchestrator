/**
 * Restoring a deferred MCP forwarder's revealed tools after it restarts.
 *
 * Deferred forwarders list a small core and reveal the rest on search. The
 * reveal lives in the forwarder process, so every restart (session restart,
 * respawn, MCP reconnect) hid the revealed tools again while the model still
 * remembered calling them. Clients such as OpenCode refuse a call to a tool
 * that is not listed, so the parent records each reveal per instance and a
 * starting forwarder asks for that list before its first `tools/list`.
 * Electron-free: bundled into aio-mcp.
 */

const REVEAL_RESTORE_ATTEMPT_TIMEOUT_MS = 2_000;
const REVEAL_RESTORE_ATTEMPTS = 3;
const REVEAL_RESTORE_RETRY_DELAY_MS = 250;

// The restore timers below are deliberately NOT unref'd. A forwarder does not
// read stdin until the restore finishes, so during the restore these timers can
// be the only thing keeping the process alive. An abandoned attempt that got its
// reply late (a main-process stall) closes its socket and clears its own timer;
// with unref'd timers the event loop then drained and the forwarder exited 0
// silently before ever answering `initialize`. Claude CLI never retries a server
// that closed, so the session lost the tools until it was respawned.

export interface RevealRestoreOutcome {
  names: string[];
  /**
   * False when the parent never answered. Distinguished from "answered with an
   * empty list" so a silent transport failure can never masquerade as "nothing
   * was revealed" — that mistranslation is what made a revealed tool vanish
   * from a later execution cell with no diagnostic anywhere.
   */
  restored: boolean;
  attempts: number;
}

/**
 * Ask the parent, through `fetchRevealed`, for the tool names this instance had
 * already revealed. The parent answers `{ revealedNames: string[] }`.
 *
 * Retries within a bounded budget rather than degrading to [] after a single
 * short race: the parent is an Electron main process that can easily be busy
 * for longer than one 1.5s window at exactly the moment a forwarder restarts,
 * and losing the race silently dropped the entire revealed surface.
 */
export async function restoreRevealedToolNames(
  fetchRevealed: () => Promise<unknown>,
  maxAttempts = REVEAL_RESTORE_ATTEMPTS,
): Promise<RevealRestoreOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const names = await attemptRevealRestore(fetchRevealed);
    if (names) {
      return { names, restored: true, attempts: attempt };
    }
    if (attempt < maxAttempts) {
      await delay(REVEAL_RESTORE_RETRY_DELAY_MS);
    }
  }
  return { names: [], restored: false, attempts: maxAttempts };
}

async function attemptRevealRestore(
  fetchRevealed: () => Promise<unknown>,
): Promise<string[] | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), REVEAL_RESTORE_ATTEMPT_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([fetchRevealed(), timeout]);
    if (result === TIMED_OUT) {
      return null;
    }
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const names = (result as Record<string, unknown>)['revealedNames'];
      if (Array.isArray(names)) {
        return names.filter((name): name is string => typeof name === 'string');
      }
    }
    // A well-formed answer in an unexpected shape is still an answer; treat it
    // as "nothing revealed" rather than retrying forever.
    return [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('reveal_restore_timeout');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
