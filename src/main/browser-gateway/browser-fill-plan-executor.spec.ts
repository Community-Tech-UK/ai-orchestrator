import { describe, expect, it, vi } from 'vitest';
import {
  executeFillPlan,
  validateFillPlan,
  type FillControlReadback,
  type FillPlanBrowserOps,
  type FillPlanStep,
} from './browser-fill-plan-executor';

/**
 * A fake browser that stores control state in a map, so the executor can be
 * exercised end-to-end without a real page. `overrides` lets a test force a
 * control to ignore writes (the silent no-op case) or succeed only after N
 * attempts (the retry case).
 */
function makeOps(
  overrides: {
    ignore?: Set<string>;
    succeedAfter?: Map<string, number>;
    throwOnSelect?: Set<string>;
  } = {},
): { ops: FillPlanBrowserOps; state: Map<string, FillControlReadback>; writes: string[] } {
  const state = new Map<string, FillControlReadback>();
  const writes: string[] = [];
  const attemptCounts = new Map<string, number>();

  const shouldApply = (target: string): boolean => {
    if (overrides.ignore?.has(target)) {
      return false;
    }
    const need = overrides.succeedAfter?.get(target);
    if (need !== undefined) {
      const seen = (attemptCounts.get(target) ?? 0) + 1;
      attemptCounts.set(target, seen);
      return seen >= need;
    }
    return true;
  };

  const ops: FillPlanBrowserOps = {
    setValue: vi.fn(async (target, value) => {
      writes.push(`set:${target}=${value}`);
      if (shouldApply(target)) {
        state.set(target, { value });
      }
    }),
    selectOption: vi.fn(async (target, value) => {
      writes.push(`select:${target}=${value}`);
      if (overrides.throwOnSelect?.has(target)) {
        throw new Error(`no option matches "${value}"`);
      }
      if (shouldApply(target)) {
        state.set(target, { value, selectedLabel: value });
      }
    }),
    setChecked: vi.fn(async (target, checked) => {
      writes.push(`check:${target}=${checked}`);
      if (shouldApply(target)) {
        state.set(target, { checked });
      }
    }),
    save: vi.fn(async (target) => {
      writes.push(`save:${target}`);
    }),
    read: vi.fn(async (target) => state.get(target) ?? {}),
  };
  return { ops, state, writes };
}

describe('validateFillPlan', () => {
  it('rejects an empty plan', () => {
    expect(validateFillPlan([])).toMatch(/no steps/);
  });

  it('rejects a set step with no value', () => {
    expect(
      validateFillPlan([{ field: 'x', kind: 'set', target: '#x' }]),
    ).toMatch(/no value/);
  });

  it('rejects a section_save with no probe (unverifiable)', () => {
    expect(
      validateFillPlan([{ field: 'save', kind: 'section_save', target: '#save' }]),
    ).toMatch(/no probeTarget/);
  });

  it('accepts a well-formed plan', () => {
    expect(
      validateFillPlan([{ field: 'x', kind: 'set', target: '#x', value: 'v' }]),
    ).toBeNull();
  });
});

describe('executeFillPlan', () => {
  const plan: FillPlanStep[] = [
    { field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' },
    { field: 'country', kind: 'select', target: '#country', value: 'United Kingdom' },
    { field: 'agreeTerms', kind: 'check', target: '#terms', checked: true },
  ];

  it('fills, verifies and checkpoints every step in order', async () => {
    const { ops } = makeOps();
    const checkpoints: number[] = [];

    const result = await executeFillPlan(plan, {
      ops,
      onCheckpoint: (index) => {
        checkpoints.push(index);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.status)).toEqual(['verified', 'verified', 'verified']);
    expect(result.steps.every((s) => s.attempts === 1)).toBe(true);
    expect(checkpoints).toEqual([0, 1, 2]);
  });

  it('fails loudly with a diff when a control silently ignores the write', async () => {
    // #country ignores the select → read-back never matches → fail.
    const { ops } = makeOps({ ignore: new Set(['#country']) });
    const checkpoints: number[] = [];

    const result = await executeFillPlan(plan, {
      ops,
      onCheckpoint: (index) => { checkpoints.push(index); },
      maxAttempts: 2,
    });

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    const failed = result.steps[1];
    expect(failed.status).toBe('failed');
    expect(failed.attempts).toBe(2);
    expect(failed.diff?.expected).toMatchObject({ value: 'United Kingdom' });
    // Only the first (verified) step checkpointed; execution stopped at the failure.
    expect(checkpoints).toEqual([0]);
    // The third step must NOT have been attempted after the failure.
    expect(result.steps).toHaveLength(2);
  });

  it('retries once and succeeds when the first apply does not take', async () => {
    const { ops } = makeOps({ succeedAfter: new Map([['#company', 2]]) });

    const result = await executeFillPlan(
      [{ field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' }],
      { ops, maxAttempts: 2 },
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].attempts).toBe(2);
  });

  it('captures the apply error when a robust select throws (invalid option)', async () => {
    const { ops } = makeOps({ throwOnSelect: new Set(['#country']) });

    const result = await executeFillPlan(
      [{ field: 'country', kind: 'select', target: '#country', value: 'Narnia' }],
      { ops, maxAttempts: 2 },
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe('failed');
    expect(result.steps[0].error).toMatch(/no option matches/);
  });

  it('verifies a section_save against its probe target', async () => {
    const { ops, state } = makeOps();
    // Simulate the save producing a visible effect the probe can read.
    (ops.save as unknown as { mockImplementation: (fn: (t: string) => Promise<void>) => void })
      .mockImplementation(async () => {
        state.set('#rowcount', { value: '1' });
      });

    const result = await executeFillPlan(
      [
        {
          field: 'addContact',
          kind: 'section_save',
          target: '#save',
          probeTarget: '#rowcount',
          effectProbe: { value: '1' },
        },
      ],
      { ops },
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe('verified');
  });

  it('fails a section_save whose effect never appears', async () => {
    const { ops } = makeOps();

    const result = await executeFillPlan(
      [
        {
          field: 'addContact',
          kind: 'section_save',
          target: '#save',
          probeTarget: '#rowcount',
          effectProbe: { value: '1' },
        },
      ],
      { ops, maxAttempts: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0].diff?.expected).toMatchObject({ value: '1' });
  });

  it('normalizes value comparison (trailing space / case) so a real match is not a false failure', async () => {
    const { ops, state } = makeOps();
    (ops.setValue as unknown as { mockImplementation: (fn: (t: string, v: string) => Promise<void>) => void })
      .mockImplementation(async (target: string) => {
        // Control echoes back a differently-cased, padded value.
        state.set(target, { value: '  UNITED KINGDOM ' });
      });

    const result = await executeFillPlan(
      [{ field: 'country', kind: 'set', target: '#c', value: 'United Kingdom' }],
      { ops },
    );

    expect(result.ok).toBe(true);
  });
});
