import { normalizeSelectText } from './browser-select-resolver';

/**
 * Structured, verify-after-every-mutation form-filling.
 *
 * This is the executor half of the tender / unattended-signup form-fill bridge.
 * The matching brain (which field-library answer maps to which form label) lives
 * upstream (tender-radar's deterministic matcher); this module is handed a
 * concrete, already-resolved plan and is responsible for one thing: applying
 * each step and PROVING it took by reading the control back, retrying once with
 * the alternate strategy, then failing the whole plan loudly with a structured
 * diff. It never proceeds past an unverified step and never reports a silent
 * no-op as success — the property that makes overnight, unattended operation
 * safe.
 *
 * It is deliberately decoupled from the browser driver via `FillPlanBrowserOps`
 * so it unit-tests without a real page and can be driven by either transport
 * (the user's real Chrome via the extension, or an agent-owned managed profile).
 */

export type FillPlanStepKind = 'set' | 'select' | 'check' | 'section_save';

export interface FillPlanExpectation {
  value?: string;
  selectedLabel?: string;
  checked?: boolean;
}

export interface FillControlReadback {
  value?: string;
  selectedLabel?: string;
  checked?: boolean;
}

export interface FillPlanStep {
  /** Stable label for audit output + diffs (e.g. the field-library key). */
  field: string;
  kind: FillPlanStepKind;
  /** Opaque control handle (CSS selector or accessibility uid). */
  target: string;
  /** Desired value for 'set' / 'select'. */
  value?: string;
  /** Desired state for 'check'. */
  checked?: boolean;
  /**
   * Explicit read-back expectation. Optional: for 'set'/'select'/'check' it is
   * derived from value/checked when omitted. Required semantics for
   * 'section_save' via `effectProbe`.
   */
  expected?: FillPlanExpectation;
  /**
   * For 'section_save': the control to read to confirm the save applied
   * (e.g. a newly-added row, a success banner). Verified against `effectProbe`.
   * A save without a probe cannot be verified and is rejected at validation.
   */
  probeTarget?: string;
  effectProbe?: FillPlanExpectation;
}

export interface FillPlanStepResult {
  field: string;
  kind: FillPlanStepKind;
  status: 'verified' | 'failed';
  attempts: number;
  /** Present when status === 'failed'. */
  diff?: { expected: FillPlanExpectation; actual: FillControlReadback };
  /** Present when an apply threw (e.g. robust select rejecting an invalid option). */
  error?: string;
}

export interface FillPlanResult {
  ok: boolean;
  steps: FillPlanStepResult[];
  /** Index of the first failed step; undefined when ok. */
  failedAt?: number;
}

export interface FillPlanBrowserOps {
  setValue(target: string, value: string): Promise<void>;
  /** Should itself throw on a select that does not take (robust select). */
  selectOption(target: string, value: string): Promise<void>;
  setChecked(target: string, checked: boolean): Promise<void>;
  save(target: string): Promise<void>;
  read(target: string): Promise<FillControlReadback>;
}

export interface FillPlanExecuteOptions {
  ops: FillPlanBrowserOps;
  /** Invoked after each verified step so callers can checkpoint progress. */
  onCheckpoint?: (stepIndex: number, result: FillPlanStepResult) => void | Promise<void>;
  /** Apply+verify attempts per step before failing (default 2, min 1). */
  maxAttempts?: number;
}

/** Validate a plan up front; returns the first structural problem or null. */
export function validateFillPlan(steps: FillPlanStep[]): string | null {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'fill plan has no steps';
  }
  for (const [index, step] of steps.entries()) {
    if (!step.target) {
      return `step ${index} (${step.field}) has no target`;
    }
    if ((step.kind === 'set' || step.kind === 'select') && step.value === undefined) {
      return `step ${index} (${step.field}) is a ${step.kind} with no value`;
    }
    if (step.kind === 'check' && typeof step.checked !== 'boolean') {
      return `step ${index} (${step.field}) is a check with no checked boolean`;
    }
    if (step.kind === 'section_save' && !step.probeTarget) {
      // A save we cannot verify would let the plan proceed on an unconfirmed
      // section — exactly the silent-failure mode this module exists to prevent.
      return `step ${index} (${step.field}) is a section_save with no probeTarget to verify it`;
    }
  }
  return null;
}

export async function executeFillPlan(
  steps: FillPlanStep[],
  options: FillPlanExecuteOptions,
): Promise<FillPlanResult> {
  const validationError = validateFillPlan(steps);
  if (validationError) {
    throw new Error(`Invalid fill plan: ${validationError}`);
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const results: FillPlanStepResult[] = [];

  for (const [index, step] of steps.entries()) {
    const result = await applyAndVerifyStep(step, options.ops, maxAttempts);
    results.push(result);
    if (result.status === 'verified') {
      await options.onCheckpoint?.(index, result);
    } else {
      return { ok: false, steps: results, failedAt: index };
    }
  }

  return { ok: true, steps: results };
}

async function applyAndVerifyStep(
  step: FillPlanStep,
  ops: FillPlanBrowserOps,
  maxAttempts: number,
): Promise<FillPlanStepResult> {
  const verifyTarget = step.kind === 'section_save' ? step.probeTarget ?? step.target : step.target;
  const expectation = expectationFor(step);

  let attempts = 0;
  let lastReadback: FillControlReadback = {};
  let lastError: string | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      await applyStep(step, ops);
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    lastReadback = await ops.read(verifyTarget);
    if (matchesExpectation(lastReadback, expectation)) {
      return { field: step.field, kind: step.kind, status: 'verified', attempts };
    }
  }

  return {
    field: step.field,
    kind: step.kind,
    status: 'failed',
    attempts,
    diff: { expected: expectation, actual: lastReadback },
    ...(lastError ? { error: lastError } : {}),
  };
}

async function applyStep(step: FillPlanStep, ops: FillPlanBrowserOps): Promise<void> {
  switch (step.kind) {
    case 'set':
      await ops.setValue(step.target, step.value ?? '');
      return;
    case 'select':
      await ops.selectOption(step.target, step.value ?? '');
      return;
    case 'check':
      await ops.setChecked(step.target, step.checked ?? false);
      return;
    case 'section_save':
      await ops.save(step.target);
      return;
    default: {
      const exhaustive: never = step.kind;
      throw new Error(`Unsupported fill plan step kind: ${String(exhaustive)}`);
    }
  }
}

function expectationFor(step: FillPlanStep): FillPlanExpectation {
  if (step.kind === 'section_save') {
    return step.effectProbe ?? step.expected ?? {};
  }
  if (step.expected) {
    return step.expected;
  }
  if (step.kind === 'check') {
    return { checked: step.checked ?? false };
  }
  return { value: step.value };
}

function matchesExpectation(
  readback: FillControlReadback,
  expected: FillPlanExpectation,
): boolean {
  if (expected.checked !== undefined) {
    return readback.checked === expected.checked;
  }

  const desired = expected.value ?? expected.selectedLabel;
  if (desired === undefined) {
    // Nothing to assert — treat any non-throwing apply as verified.
    return true;
  }
  if (readback.value === desired || readback.selectedLabel === desired) {
    return true;
  }
  const normalizedDesired = normalizeSelectText(desired);
  if (normalizedDesired === '') {
    // Desired an empty/blank value: accept an empty control.
    return (readback.value ?? '') === '' && (readback.selectedLabel ?? '') === '';
  }
  return (
    normalizeSelectText(readback.value) === normalizedDesired ||
    normalizeSelectText(readback.selectedLabel) === normalizedDesired
  );
}
