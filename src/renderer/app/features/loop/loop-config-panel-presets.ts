/**
 * B4 — the preset half of the loop config panel, kept out of the panel itself.
 *
 * `loop-config-panel.component.ts` sits against a hard 700-line ceiling, and
 * the preset wiring pushed it over. Extracting is the required fix — raising
 * the ceiling would just move the problem — and this half is genuinely
 * separable: it needs to read and write nine fields and knows nothing else
 * about the panel.
 *
 * The controller takes accessors rather than the component, so it can be tested
 * without mounting a dialog.
 */
import { computed, signal, type Signal, type WritableSignal } from '@angular/core';

import {
  loopPresetById,
  loopPresetOverrides,
  type LoopPresetId,
  type LoopPresetOverride,
  type LoopPresetValues,
} from './loop-presets';
import { buildLoopPreflightSummary } from './loop-preflight-summary';

/**
 * The panel's own signals for the nine preset-owned fields.
 *
 * Passing the signals rather than hand-written read/write closures keeps the
 * call site to one object literal — which matters because the panel is at a
 * hard LOC ceiling, and it removes the chance of the read and write halves
 * drifting out of sync field by field.
 */
export type LoopPresetSignals = {
  [K in keyof LoopPresetValues]: WritableSignal<LoopPresetValues[K]>;
};

export interface LoopPresetIo {
  fields: LoopPresetSignals;
  /** Needed by the preflight summary's completion sentence. */
  verifyCommand: () => string;
}

const FIELDS = [
  'maxIterations', 'maxDollars', 'allowDestructive', 'managedIsolation',
  'completionMode', 'requiredCleanPasses', 'initialStage',
  'operatorReviewedCompletion', 'freshEyesReview',
] as const satisfies readonly (keyof LoopPresetValues)[];

function readValues(fields: LoopPresetSignals): LoopPresetValues {
  const out = {} as Record<string, unknown>;
  for (const key of FIELDS) out[key] = fields[key]();
  return out as unknown as LoopPresetValues;
}

function writeValues(fields: LoopPresetSignals, values: LoopPresetValues): void {
  for (const key of FIELDS) {
    (fields[key] as WritableSignal<unknown>).set(values[key]);
  }
}

export interface LoopPresetController {
  selectedPresetId: Signal<LoopPresetId | null>;
  overrides: Signal<LoopPresetOverride[]>;
  /** What the run will actually do, right now. */
  displayedContract: Signal<string>;
  apply: (id: LoopPresetId) => void;
  resetToPreset: () => void;
}

export function createLoopPresetController(io: LoopPresetIo): LoopPresetController {
  /**
   * Sticky: the last preset actually clicked, not "does the current state match
   * a preset". The changes drawer needs something to diff against, and a
   * derived value would vanish the moment the operator changed one field —
   * exactly when the diff becomes interesting.
   */
  const selected = signal<LoopPresetId | null>(null);

  const overrides = computed(
    () => loopPresetOverrides(loopPresetById(selected()), readValues(io.fields)),
  );

  /**
   * The preset's own canned prose is shown ONLY while nothing is overridden.
   *
   * Once a field differs, that prose describes a policy this run no longer has
   * — the original bug here displayed "never runs a destructive command" for a
   * run with destructive commands enabled. With a field overridden, or with no
   * preset selected at all (a hand-tuned config), the summary is composed from
   * the live values instead, so there is always an honest account of what is
   * about to start.
   */
  const displayedContract = computed(() => {
    const preset = loopPresetById(selected());
    if (preset && overrides().length === 0) return preset.contract;
    return buildLoopPreflightSummary({
      ...readValues(io.fields),
      verifyCommand: io.verifyCommand(),
    });
  });

  const apply = (id: LoopPresetId): void => {
    const preset = loopPresetById(id);
    if (!preset) return;
    writeValues(io.fields, preset.values);
    selected.set(id);
  };

  return {
    selectedPresetId: selected.asReadonly(),
    overrides,
    displayedContract,
    apply,
    /** Put back every field this preset owns, leaving everything else alone. */
    resetToPreset: (): void => {
      const id = selected();
      if (id) apply(id);
    },
  };
}
