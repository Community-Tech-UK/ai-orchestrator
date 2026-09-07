/**
 * B4 — a preset is a promise about what a run will do, so the tests that matter
 * are the ones that stop a preset promising something the panel would reject or
 * the UI cannot deliver.
 */
import { describe, expect, it } from 'vitest';

import {
  LOOP_PRESETS,
  loopPresetById,
  loopPresetOverrides,
  type LoopPresetValues,
} from './loop-presets';

const base = (): LoopPresetValues => ({ ...LOOP_PRESETS[0]!.values });

describe('the preset catalogue', () => {
  it('offers the four intents', () => {
    expect(LOOP_PRESETS.map((p) => p.id)).toEqual([
      'safe-implementation', 'investigate', 'plan-only', 'review-until-clean',
    ]);
  });

  it('gives every preset an intent and a contract worth reading', () => {
    for (const preset of LOOP_PRESETS) {
      expect(preset.intent.length).toBeGreaterThan(20);
      expect(preset.contract.length).toBeGreaterThan(60);
    }
  });

  /**
   * The panel rejects `operatorReviewedCompletion` or `branchSelect` without a
   * cost cap. A preset that produced a state the panel refuses would be a
   * button that cannot be used.
   */
  it('never produces a config the panel’s own validation would reject', () => {
    for (const preset of LOOP_PRESETS) {
      if (preset.values.operatorReviewedCompletion) {
        expect(preset.values.maxDollars, `${preset.id} needs a cap`).not.toBeNull();
      }
    }
  });

  /**
   * UX9: none of `loopRecipe`, `reviewStyle` or `contextStrategy` is reachable
   * from the current panel, so a preset setting them would claim authority over
   * a dead control.
   */
  it('sets no field the UI cannot reach', () => {
    const allowed = new Set(Object.keys(base()));
    for (const preset of LOOP_PRESETS) {
      for (const key of Object.keys(preset.values)) {
        expect(allowed.has(key), `${preset.id} sets unknown field ${key}`).toBe(true);
      }
      expect(preset.values).not.toHaveProperty('loopRecipe');
      expect(preset.values).not.toHaveProperty('reviewStyle');
      expect(preset.values).not.toHaveProperty('contextStrategy');
    }
  });

  it('keeps destructive commands off in every preset', () => {
    expect(LOOP_PRESETS.filter((p) => p.values.allowDestructive)).toEqual([]);
  });

  it('keeps every preset isolated', () => {
    expect(LOOP_PRESETS.filter((p) => !p.values.managedIsolation)).toEqual([]);
  });

  it('caps every preset — none is unbounded', () => {
    for (const preset of LOOP_PRESETS) {
      expect(preset.values.maxIterations).not.toBeNull();
      expect(preset.values.maxDollars).not.toBeNull();
    }
  });

  it('makes "Plan only" hand the completion decision to the operator', () => {
    const planOnly = loopPresetById('plan-only')!;
    expect(planOnly.values.operatorReviewedCompletion).toBe(true);
    expect(planOnly.values.initialStage).toBe('PLAN');
  });

  it('makes "Review / fix until clean" the most demanding on clean passes', () => {
    const passes = LOOP_PRESETS.map((p) => p.values.requiredCleanPasses);
    expect(loopPresetById('review-until-clean')!.values.requiredCleanPasses)
      .toBe(Math.max(...passes));
  });
});

describe('loopPresetById', () => {
  it('finds a preset', () => {
    expect(loopPresetById('investigate')?.label).toBe('Investigate');
  });

  it('is null for no selection', () => {
    expect(loopPresetById(null)).toBeNull();
  });
});

describe('loopPresetOverrides', () => {
  it('reports nothing when the config still matches', () => {
    const preset = LOOP_PRESETS[0]!;
    expect(loopPresetOverrides(preset, { ...preset.values })).toEqual([]);
  });

  it('reports nothing when no preset was ever chosen', () => {
    expect(loopPresetOverrides(null, base())).toEqual([]);
  });

  it('names the changed field in words, with both values', () => {
    const preset = LOOP_PRESETS[0]!;
    const overrides = loopPresetOverrides(preset, { ...preset.values, allowDestructive: true });
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({
      field: 'allowDestructive',
      label: 'Allow destructive commands',
      presetValue: false,
      currentValue: true,
    });
  });

  it('reports every changed field, not just the first', () => {
    const preset = LOOP_PRESETS[0]!;
    const overrides = loopPresetOverrides(preset, {
      ...preset.values,
      allowDestructive: true,
      maxDollars: 999,
    });
    expect(overrides.map((o) => o.field).sort()).toEqual(['allowDestructive', 'maxDollars']);
  });
});
