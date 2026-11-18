/**
 * Fire-time gate for a `spawn_child` command that asks for hardened mode (the macOS Seatbelt jail).
 *
 * The adapter factory already refuses a hardened session it cannot jail, but it does so after the child exists,
 * as a child that ends in an error. This refuses first, with a reason the parent can act on, and creates nothing.
 * Hardening only restricts a session, so the gate never decides whether a parent is allowed to ask: it checks only
 * that the request can be honoured exactly as written.
 */

import { hardenedModeUnsupportedMessage, isHardenedModeSupported } from '../../shared/hardened-mode-support';
import type { SpawnChildCommand } from './orchestration-protocol.types';

/** The parts of the asking session that decide where and with what a child would run. */
export interface HardenedChildParent {
  provider?: string;
  executionLocation?: { type: string };
}

/**
 * Why a hardened child cannot be created as requested, in plain words, or `undefined` when it can (or when the
 * command does not ask for hardened mode). The provider and the worker computer are resolved exactly as the child
 * creation resolves them: the command's own choice first, then the parent's. `platform` defaults to this computer.
 */
export function hardenedChildRefusal(
  command: Pick<SpawnChildCommand, 'hardened' | 'provider' | 'node'>,
  parent: HardenedChildParent,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (command.hardened !== true) return undefined;
  if (command.node || parent.executionLocation?.type === 'remote') {
    return 'Hardened mode is not supported for remote instances (Phase A is local macOS only). '
      + 'Start the child on this computer, or without hardened mode.';
  }
  if (platform !== 'darwin') {
    return 'Hardened mode needs macOS (it uses the Seatbelt sandbox), and this computer is not a Mac. '
      + 'Start the child without hardened mode, or on a Mac.';
  }
  const provider = command.provider || parent.provider || 'auto';
  if (provider === 'auto') {
    return 'A hardened child must name its provider (for example "provider":"codex"): '
      + 'hardened mode only runs for providers that were tested inside the jail.';
  }
  return isHardenedModeSupported(provider) ? undefined : hardenedModeUnsupportedMessage(provider);
}
