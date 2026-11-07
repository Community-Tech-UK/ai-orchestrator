/**
 * Pure send-timeout helper for the instance messaging store.
 *
 * Split out of instance-messaging.store.ts. Resolves how long the renderer's
 * sendInput IPC guard should wait per provider before treating the bridge as
 * wedged — deliberately generous (or disabled) for providers whose adapters
 * keep the send promise open for a whole turn.
 */
import type { IpcResponse } from '../../services/ipc';

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
          message: `Send input timed out after ${timeoutMs / 1000}s. Delivery uncertain, not retried. Check the conversation before sending again.`,
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
