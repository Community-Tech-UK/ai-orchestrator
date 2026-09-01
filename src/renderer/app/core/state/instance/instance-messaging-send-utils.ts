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
const NO_SEND_INPUT_IPC_TIMEOUT_MS = null;

export function getSendInputTimeoutMs(provider: Instance['provider']): number | null {
  // These adapters keep the IPC send promise open for the whole turn. Their
  // main-process runtimes own bounded inactivity detection and cancellation,
  // so a renderer deadline would only abandon the local wait while leaving
  // the provider turn alive. That makes the composer look idle and lets the
  // next send collide with the still-running turn.
  // Grok Build uses the same ACP session/prompt contract as Cursor/Copilot.
  if (
    provider === 'codex'
    || provider === 'cursor'
    || provider === 'copilot'
    || provider === 'grok'
  ) {
    return NO_SEND_INPUT_IPC_TIMEOUT_MS;
  }
  return DEFAULT_SEND_INPUT_IPC_TIMEOUT_MS;
}
