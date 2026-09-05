/**
 * UX3 — loop HUD tooltip copy that depends on live state.
 *
 * Split from `loop-control.component.ts` to keep it inside its size ceiling,
 * and because the wording rules are worth testing directly: "Resume" versus
 * "Resume anyway" is a different promise to the operator, and getting it wrong
 * is exactly the dishonesty UX3 exists to remove.
 */

import type { LoopInferredPhase } from '@shared/types/loop-health.types';
import { copyFor, type TooltipCopyKey } from '../../shared/tooltip/tooltip-copy';

/**
 * After a no-progress pause, nothing about the situation has changed — saying
 * so is the difference between an informed click and a surprised one.
 */
export function resumeTooltipFor(pauseKind: string | null | undefined): string {
  return pauseKind === 'no-progress' ? copyFor('loop.resumeAnyway') : copyFor('loop.resume');
}

/**
 * The metric strip is one dense line. Its tooltip is where the per-number
 * honesty lives: what is estimated, what is provider-reported, and the fact
 * that an iteration cap adds a wrap-up turn on top.
 */
export function metricStripTooltipFor(
  hasActiveLoop: boolean,
  phase: LoopInferredPhase | null | undefined,
): string {
  if (!hasActiveLoop) return '';
  return [
    copyFor('loop.iterations'),
    copyFor('loop.tokens'),
    copyFor('loop.cost'),
    // Only explain the phase when one has actually been inferred; describing a
    // line that is not on screen is its own small dishonesty.
    ...(phase ? [copyFor('loop.phase')] : []),
  ].join('\n');
}

/**
 * L6 chip wording → its copy key. Keyed off the exact strings
 * `NON_CONVERGENCE_CHIP` emits, so a reworded chip fails the spec rather than
 * silently losing its tooltip.
 */
const NON_CONVERGENCE_CHIP_COPY: Readonly<Record<string, TooltipCopyKey>> = {
  'review not converging': 'loop.chip.reviewNotConverging',
  'landable · uncommitted': 'loop.chip.landableUncommitted',
  'scope widened': 'loop.chip.scopeWidened',
  'no progress': 'loop.chip.noProgress',
};

/** Chip copy, matched on the chip's own wording (`buildHonestyChips`). */
export function chipTooltipFor(chip: string): string {
  if (chip.startsWith('unstick')) return copyFor('loop.chip.unstick');
  if (chip.startsWith('wrap-up')) return copyFor('loop.chip.wrapUp');
  if (chip.endsWith('parked')) return copyFor('loop.chip.parked');
  const namedReason = NON_CONVERGENCE_CHIP_COPY[chip];
  if (namedReason) return copyFor(namedReason);
  return '';
}
