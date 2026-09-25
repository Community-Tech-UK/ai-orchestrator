import { CodexAppServerRuntimeError } from './app-server-runtime-errors';
import type { CompactionGateOutcome } from './compaction-gate';

const READY_WARNING_MS = 120_000;
const READY_HARD_TIMEOUT_MS = 30 * 60_000;
const READY_POLL_MS = 500;

export function isActiveTurnCollision(error: unknown): error is CodexAppServerRuntimeError {
  return error instanceof CodexAppServerRuntimeError
    && error.kind === 'request-rejected'
    && error.recoverability === 'retry-thread'
    && error.message === 'Codex app-server runtime already has an active turn';
}

/** The caller owns the provider state checks; only a pre-turn collision is safe to retry. */
export async function sendCodexOrchestrationResponse(
  message: string,
  deps: {
    isAppServerMode: () => boolean;
    isReady: () => boolean;
    hasActiveTurn: () => boolean;
    isCompactionRunning?: () => boolean;
    awaitCompactionSettled?: () => Promise<CompactionGateOutcome>;
    sendInput: (message: string) => Promise<void>;
    onDelayed?: () => void;
  },
): Promise<void> {
  if (!deps.isAppServerMode()) return deps.sendInput(message);
  const startedAt = Date.now();
  let warned = false;
  while (true) {
    if (!deps.isReady()) {
      throw new Error('Codex app-server ended before the orchestration response could be delivered');
    }
    if (deps.isCompactionRunning?.()) {
      const outcome = await deps.awaitCompactionSettled?.();
      if (outcome !== 'observed') {
        throw new Error(`Codex provider compaction did not settle before orchestration delivery (${outcome ?? 'unknown'})`);
      }
      continue;
    }
    if (!deps.hasActiveTurn()) {
      try {
        await deps.sendInput(message);
        return;
      } catch (error) {
        // The runtime rejects this before turn/start. No provider input was sent.
        if (!isActiveTurnCollision(error)) throw error;
      }
    }
    const elapsed = Date.now() - startedAt;
    if (!warned && elapsed >= READY_WARNING_MS) {
      warned = true;
      try { deps.onDelayed?.(); } catch { /* a display failure cannot cancel provider delivery */ }
    }
    const remaining = READY_HARD_TIMEOUT_MS - elapsed;
    if (remaining <= 0) {
      throw new Error('Timed out waiting for the Codex turn to accept the orchestration response');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(READY_POLL_MS, remaining)));
  }
}
