/**
 * Compaction settings for Harness's own Claude sessions (T13 steps 4 and 6).
 *
 * - A `PreCompact` hook tells the summariser what to keep, per role (the CLI adds
 *   an exit-0 hook's stdout to its compaction instructions; verified on 2.1.304).
 *   Queue workers, loop rounds and scheduled jobs only; ordinary helpers and
 *   reviewers are short-lived.
 * - `precomputeCompactionEnabled: false` stops the CLI summarising in the
 *   background before the window fills. That summary is thrown away if the
 *   conversation carries on, and nothing yet shows whether it costs anything
 *   (the key exists in the 2.1.304 settings schema; older CLIs ignore unknown keys).
 */

import type { MachineSessionReason } from '../../../shared/utils/machine-session';
import { buildPreCompactRoleHookCommand, type PreCompactRole } from '../hooks/hook-path-resolver';

/** How long a hook may run before the CLI gives up on it; the hook only prints text. */
const PRECOMPACT_HOOK_TIMEOUT_SECONDS = 5;

export interface ClaudePreCompactOverlay {
  hooks?: { PreCompact: { hooks: { type: 'command'; command: string; timeout: number }[] }[] };
  precomputeCompactionEnabled: false;
}

export function preCompactRoleFor(reason: MachineSessionReason | undefined): PreCompactRole | undefined {
  switch (reason) {
    case 'plan-queue': return 'queue-worker';
    case 'loop': return 'loop';
    case 'automation': return 'automation';
    default: return undefined;
  }
}

/** The settings to merge into a machine session's `--settings` overlay, or undefined for a person's own session. */
export function buildPreCompactOverlay(
  reason: MachineSessionReason | undefined,
  hookCommand: (role: PreCompactRole) => string | undefined = buildPreCompactRoleHookCommand,
): ClaudePreCompactOverlay | undefined {
  if (!reason) return undefined;
  const role = preCompactRoleFor(reason);
  const command = role ? hookCommand(role) : undefined;
  return {
    precomputeCompactionEnabled: false,
    ...(command ? { hooks: { PreCompact: [{ hooks: [{ type: 'command' as const, command, timeout: PRECOMPACT_HOOK_TIMEOUT_SECONDS }] }] } } : {}),
  };
}
