/**
 * Pure send-timeout helper for the instance messaging store.
 *
 * Split out of instance-messaging.store.ts. Resolves how long the renderer's
 * sendInput IPC guard should wait per provider before treating the bridge as
 * wedged — deliberately generous (or disabled) for providers whose adapters
 * keep the send promise open for a whole turn.
 */
import type { Instance } from './instance.types';

const DEFAULT_SEND_INPUT_IPC_TIMEOUT_MS = 60_000;
const TURN_BLOCKING_SEND_INPUT_IPC_TIMEOUT_MS = 11 * 60_000;
const NO_SEND_INPUT_IPC_TIMEOUT_MS = null;

export function getSendInputTimeoutMs(provider: Instance['provider']): number | null {
  // Codex app-server turns can legitimately run for much longer than the
  // renderer's bridge guard while still streaming output and heartbeats.
  // Let the main-process Codex watchdogs own failure detection so the
  // renderer does not clear the busy UI while text is still arriving.
  if (provider === 'codex') {
    return NO_SEND_INPUT_IPC_TIMEOUT_MS;
  }

  // Some adapters keep the IPC send promise open for the whole turn rather
  // than just message acceptance. Keep this renderer guard beyond backend
  // watchdogs so it only catches a wedged bridge, not normal long turns.
  // Grok Build uses the same ACP session/prompt contract as Cursor.
  if (provider === 'cursor' || provider === 'copilot' || provider === 'grok') {
    return TURN_BLOCKING_SEND_INPUT_IPC_TIMEOUT_MS;
  }
  return DEFAULT_SEND_INPUT_IPC_TIMEOUT_MS;
}
