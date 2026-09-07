/**
 * B4 — start a loop by naming what you want, not by filling in twenty fields.
 *
 * The loop config panel exposes real, useful controls, and it asks the operator
 * to assemble a policy out of them before they have run anything. A preset is
 * an intent — "investigate this, don't change anything" — expressed as the
 * field values that actually produce it.
 *
 * **A preset only sets controls the UI can reach.** `loopRecipe`, `reviewStyle`
 * and `contextStrategy` are deliberately absent: UX9 found none of them are
 * reachable from the current panel, and a preset that "configures" a dead
 * control is claiming authority it does not have. That is the same
 * confident-wrong-claim failure this backlog keeps fixing elsewhere.
 *
 * Dangerous combinations are already blocked by the panel's own validation
 * (`operatorReviewedCompletion` and `branchSelect` each require a cost cap).
 * Every preset that turns those on sets its own cap, so applying one can never
 * produce a state the panel would reject — no second conflict detector needed.
 */

export type LoopPresetId = 'safe-implementation' | 'investigate' | 'plan-only' | 'review-until-clean';

/**
 * The fields a preset is allowed to set.
 *
 * Deliberately a narrow, named subset rather than `Partial<everything>`: a
 * preset that could set any field would be able to silently pin controls the
 * operator has no way to see, which is exactly what makes presets untrustworthy.
 */
export interface LoopPresetValues {
  maxIterations: number | null;
  maxDollars: number | null;
  allowDestructive: boolean;
  managedIsolation: boolean;
  completionMode: 'review-driven' | 'gated';
  requiredCleanPasses: number;
  initialStage: 'PLAN' | 'REVIEW' | 'IMPLEMENT';
  operatorReviewedCompletion: boolean;
  freshEyesReview: boolean;
}

export interface LoopPreset {
  id: LoopPresetId;
  label: string;
  /** What you would say out loud to ask for this. */
  intent: string;
  /**
   * The execution contract in plain language: authority, isolation,
   * destructive-command posture, reviewer, stage, budget. Shown ONLY while the
   * config still matches the preset — see `buildLoopPreflightSummary` for what
   * replaces it once a field is overridden.
   */
  contract: string;
  values: LoopPresetValues;
}

export const LOOP_PRESETS: readonly LoopPreset[] = [
  {
    id: 'safe-implementation',
    label: 'Safe implementation',
    intent: 'Build the thing, carefully, without touching anything it should not.',
    contract:
      'Works in its own isolated checkout and never runs a destructive command. '
      + 'Reviews its own work with fresh eyes and needs two clean passes before it '
      + 'calls itself done. Stops after 50 iterations or $20, whichever comes first.',
    values: {
      maxIterations: 50,
      maxDollars: 20,
      allowDestructive: false,
      managedIsolation: true,
      completionMode: 'review-driven',
      requiredCleanPasses: 2,
      initialStage: 'IMPLEMENT',
      operatorReviewedCompletion: false,
      freshEyesReview: true,
    },
  },
  {
    id: 'investigate',
    label: 'Investigate',
    intent: 'Find out what is going on. Do not change anything yet.',
    contract:
      'Reads and runs commands to understand the problem, in its own isolated '
      + 'checkout, with destructive commands off. Short by design — 15 iterations '
      + 'or $5 — because an investigation that runs all night has stopped '
      + 'investigating.',
    values: {
      maxIterations: 15,
      maxDollars: 5,
      allowDestructive: false,
      managedIsolation: true,
      completionMode: 'review-driven',
      requiredCleanPasses: 1,
      initialStage: 'REVIEW',
      operatorReviewedCompletion: false,
      freshEyesReview: false,
    },
  },
  {
    id: 'plan-only',
    label: 'Plan only',
    intent: 'Write me a plan. I will decide whether to run it.',
    contract:
      'Produces a plan and stops for you to read it — you approve completion, not '
      + 'the model. Isolated, no destructive commands, capped at 10 iterations and '
      + '$5. Nothing is implemented until you say so.',
    values: {
      maxIterations: 10,
      maxDollars: 5,
      allowDestructive: false,
      managedIsolation: true,
      completionMode: 'gated',
      requiredCleanPasses: 1,
      initialStage: 'PLAN',
      operatorReviewedCompletion: true,
      freshEyesReview: false,
    },
  },
  {
    id: 'review-until-clean',
    label: 'Review / fix until clean',
    intent: 'Keep reviewing and fixing until nothing is left to find.',
    contract:
      'Alternates independent review and fixes until three consecutive passes come '
      + 'back clean. Isolated, no destructive commands. The longest of the four: up '
      + 'to 100 iterations or $40, because "until clean" is open-ended by nature.',
    values: {
      maxIterations: 100,
      maxDollars: 40,
      allowDestructive: false,
      managedIsolation: true,
      completionMode: 'review-driven',
      requiredCleanPasses: 3,
      initialStage: 'REVIEW',
      operatorReviewedCompletion: false,
      freshEyesReview: true,
    },
  },
];

export function loopPresetById(id: LoopPresetId | null): LoopPreset | null {
  if (!id) return null;
  return LOOP_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Human wording for one overridden field, for the changes drawer. */
const FIELD_LABELS: Readonly<Record<keyof LoopPresetValues, string>> = {
  maxIterations: 'Max iterations',
  maxDollars: 'Cost cap',
  allowDestructive: 'Allow destructive commands',
  managedIsolation: 'Isolated checkout',
  completionMode: 'Completion mode',
  requiredCleanPasses: 'Clean passes required',
  initialStage: 'Starting stage',
  operatorReviewedCompletion: 'You approve completion',
  freshEyesReview: 'Fresh-eyes review',
};

export interface LoopPresetOverride {
  field: keyof LoopPresetValues;
  label: string;
  presetValue: LoopPresetValues[keyof LoopPresetValues];
  currentValue: LoopPresetValues[keyof LoopPresetValues];
}

/**
 * Fields where the current config differs from the preset that was applied.
 *
 * This is what makes the "N changes from this preset" drawer possible, and it
 * is why the selected preset id is sticky — it names the last preset actually
 * chosen, not "does the current state happen to match one". Without a
 * remembered choice there is nothing to diff against.
 */
export function loopPresetOverrides(
  preset: LoopPreset | null,
  current: LoopPresetValues,
): LoopPresetOverride[] {
  if (!preset) return [];
  const out: LoopPresetOverride[] = [];
  for (const field of Object.keys(preset.values) as (keyof LoopPresetValues)[]) {
    if (current[field] !== preset.values[field]) {
      out.push({
        field,
        label: FIELD_LABELS[field],
        presetValue: preset.values[field],
        currentValue: current[field],
      });
    }
  }
  return out;
}
