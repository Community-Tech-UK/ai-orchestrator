/**
 * Pure send-timeout helper for the instance messaging store.
 *
 * Split out of instance-messaging.store.ts. Resolves how long the renderer's
 * sendInput IPC guard should wait per provider before treating the bridge as
 * wedged — deliberately generous (or disabled) for providers whose adapters
 * keep the send promise open for a whole turn.
 */
import type { IpcResponse } from '../../services/ipc';
import type { Instance } from './instance.types';

const DEFAULT_SEND_INPUT_IPC_TIMEOUT_MS = 60_000;
const NO_SEND_INPUT_IPC_TIMEOUT_MS = null;

export function getSendInputTimeoutMs(provider: Instance['provider']): number | null {
  // These adapters keep the IPC send promise open for the whole turn. Their
  // main-process runtimes own bounded inactivity detection and cancellation,
  // so a renderer deadline would only abandon the local wait while leaving
  // the provider turn alive. That makes the composer look idle and lets the
  // next send collide with the still-running turn.
  // Grok Build and OpenCode use the same ACP session/prompt contract as Cursor/Copilot.
  if (
    provider === 'codex'
    || provider === 'cursor'
    || provider === 'copilot'
    || provider === 'grok'
    || provider === 'opencode'
  ) {
    return NO_SEND_INPUT_IPC_TIMEOUT_MS;
  }
  return DEFAULT_SEND_INPUT_IPC_TIMEOUT_MS;
}

/** Race a send IPC against its provider deadline. `null` timeout = wait for the bridge. */
export async function sendInputWithTimeout(
  operation: Promise<IpcResponse>,
  timeoutMs: number | null
): Promise<IpcResponse> {
  if (timeoutMs === null) {
    return operation;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<IpcResponse>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        success: false,
        error: {
          message: `Send input timed out after ${timeoutMs / 1000}s. The app cleared the optimistic busy state; please retry after checking the session.`,
        },
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
