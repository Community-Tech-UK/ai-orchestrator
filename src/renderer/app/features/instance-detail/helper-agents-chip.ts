import type { Instance } from '../../core/state/instance/instance.types';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import type { DockChipContext, DockChipDef } from './session-status-dock.rules';

/**
 * "N helper agent(s) running" chip descriptor (October follow-ups part 7c).
 *
 * Pure: helpers are native agents running inside this provider session (the
 * instance's `nativeHelpers` summary); the count decides whether the chip shows
 * and what it says. Separate child sessions are never this population. The chip
 * is informational — the per-helper rows sit in the transcript — so it
 * registers into the status strip's typed `DOCK_CHIPS` list as `helpersDockChip`
 * with no panel.
 */

export interface HelperAgentsChip {
  /** e.g. "1 helper agent running" / "2 helper agents running". */
  label: string;
  tooltipKey: 'strip.helperAgents';
}

export const helperAgentsTooltip = copyFor('strip.helperAgents');

/** Hidden at zero; singular and plural wording; never the bare word "Agents". */
export function helperAgentsChip(running: number): HelperAgentsChip | null {
  if (!Number.isFinite(running) || running <= 0) return null;
  return {
    label: running === 1 ? '1 helper agent running' : `${running} helper agents running`,
    tooltipKey: 'strip.helperAgents',
  };
}

/**
 * Part 7c: helper agents this session started, currently running.
 * Reads the owning session's native summary lazily (never the child-session
 * count) so draft composers never read live state.
 */
export function sessionHelperAgentsRunning(
  instanceId: string,
  getInstance: (id: string) => Pick<Instance, 'nativeHelpers'> | undefined,
): number {
  if (!instanceId || instanceId === 'new') return 0;
  return getInstance(instanceId)?.nativeHelpers?.running ?? 0;
}

/**
 * The status strip's typed registration for part 7c (October follow-ups).
 * `session-status-dock.rules.ts` appends this to `DOCK_CHIPS`, so the chip joins
 * the strip's overflow rule instead of inventing a new spot above the message
 * box. Informational: `helperAgentsChip` decides presence and wording from the
 * native-helper count alone — never the child-session count, which these
 * helpers are not — and no panel is registered.
 */
export const helpersDockChip: DockChipDef = {
  id: 'helpers',
  blocker: false,
  informational: true,
  icon: {
    paths: [
      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2',
      'M23 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
    circles: [{ cx: 9, cy: 7, r: 4 }],
  },
  describe: (ctx: DockChipContext) => {
    const chip = helperAgentsChip(ctx.helperAgentsRunning);
    return chip ? { label: chip.label, title: helperAgentsTooltip, badge: null } : null;
  },
};
