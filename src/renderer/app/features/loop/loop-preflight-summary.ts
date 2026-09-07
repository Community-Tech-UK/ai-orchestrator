/**
 * B4 — what this run will actually do, in a paragraph, before it starts.
 *
 * This exists because of a bug worth stating plainly. The preset picker
 * originally showed the chosen preset's canned contract prose, resolved from
 * its own lookup table. That prose kept showing verbatim after the operator
 * overrode a field — so picking "Safe implementation" and then switching
 * destructive commands on still displayed "never runs a destructive command".
 * A summary that describes a policy the run does not have is worse than no
 * summary: it is a confident wrong claim about what is about to happen.
 *
 * So the summary is composed from the ACTUAL current values, never from fixed
 * prose. It also covers the case a preset never could: an operator who
 * hand-tuned everything and picked no preset at all — previously the most
 * common case for existing users, and the one that got no summary whatsoever.
 */

import type { LoopPresetValues } from './loop-presets';

export interface LoopPreflightInput extends LoopPresetValues {
  /** The verify command, if one is configured. */
  verifyCommand?: string;
}

function budgetClause(maxIterations: number | null, maxDollars: number | null): string {
  const parts: string[] = [];
  if (maxIterations !== null) parts.push(`${maxIterations} iterations`);
  if (maxDollars !== null) parts.push(`$${maxDollars}`);
  if (parts.length === 0) {
    // Said out loud on purpose. An unbounded run is a legitimate choice and the
    // shipped default, but the operator should know that is what they have.
    return 'It has no iteration or cost cap, so it runs until it finishes or you stop it.';
  }
  if (parts.length === 1) return `It stops after ${parts[0]}.`;
  return `It stops after ${parts.join(' or ')}, whichever comes first.`;
}

function completionClause(input: LoopPreflightInput): string {
  if (input.operatorReviewedCompletion) {
    return 'You decide when it is done — it cannot mark itself complete.';
  }
  if (input.completionMode === 'review-driven') {
    const n = input.requiredCleanPasses;
    const reviewer = input.freshEyesReview
      ? 'an independent fresh-eyes reviewer'
      : 'its own review';
    return `It finishes when ${reviewer} returns ${n} consecutive clean pass${n === 1 ? '' : 'es'}.`;
  }
  return input.verifyCommand?.trim()
    ? `It finishes when \`${input.verifyCommand.trim()}\` passes and it declares itself done.`
    : 'It finishes when it declares itself done, with no verify command to check that claim.';
}

function stageLabel(stage: LoopPreflightInput['initialStage']): string {
  if (stage === 'PLAN') return 'planning';
  if (stage === 'REVIEW') return 'reviewing';
  return 'implementing';
}

/**
 * One honest paragraph about the configuration as it stands.
 *
 * Ordered by what can hurt you: where it runs, what it may do, how it decides
 * it is finished, and what it will cost.
 */
export function buildLoopPreflightSummary(input: LoopPreflightInput): string {
  const isolation = input.managedIsolation
    ? 'in its own isolated checkout'
    : 'directly in your working checkout, with no isolation';
  const destructive = input.allowDestructive
    ? 'It is allowed to run destructive commands.'
    : 'It cannot run destructive commands.';

  return [
    `Starts by ${stageLabel(input.initialStage)}, working ${isolation}.`,
    destructive,
    completionClause(input),
    budgetClause(input.maxIterations, input.maxDollars),
  ].join(' ');
}
