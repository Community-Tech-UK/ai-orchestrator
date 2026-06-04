/**
 * LF-3a (loopfixex §13) — loop start-config preparation.
 *
 * Verifies the two start-time safety rules: the default completion authority
 * (fresh-eyes cross-model review when no verify command is supplied — we no
 * longer infer/force a heavy machine verify command) and the cost-cap
 * precondition for operator-reviewed loops.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLoopStartConfig } from './loop-start-config';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { LoopConfigInput } from '@contracts/schemas/loop';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-start-config-'));
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function mkConfig(overrides: Partial<LoopConfigInput> = {}): LoopConfigInput {
  const base = defaultLoopConfig(workspace, 'goal');
  return {
    initialPrompt: 'goal',
    workspaceCwd: workspace,
    caps: base.caps,
    completion: base.completion,
    ...overrides,
  } as LoopConfigInput;
}

describe('prepareLoopStartConfig (LF-3a)', () => {
  it('defaults user-started loops to review-driven (self-review) — no auto cross-model review, no inferred verify command', async () => {
    // Even with a package.json "verify" script present, we no longer infer or
    // force it. The default is review-driven self-review; cross-model review is
    // an opt-in, so it must NOT be auto-enabled.
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { verify: 'npm test' } }));

    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: undefined },
    }));

    expect(prepared.completion?.mode).toBe('review-driven');
    expect(prepared.completion?.verifyCommand ?? '').toBe('');
    expect(prepared.completion?.crossModelReview?.enabled ?? false).toBe(false);
  });

  it('keeps an explicit verify command untouched and still defaults to review-driven (verify folds in)', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: 'make check', mode: undefined },
    }));

    expect(prepared.completion?.verifyCommand).toBe('make check');
    expect(prepared.completion?.mode).toBe('review-driven');
  });

  it('does not throw when no verify command and not operator-reviewed — defaults to review-driven', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: undefined },
    }));

    expect(prepared.completion?.mode).toBe('review-driven');
    expect(prepared.completion?.verifyCommand ?? '').toBe('');
  });

  it('honours an explicit gated mode and defaults its authority to fresh-eyes cross-model review when no verify command', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: 'gated' },
    }));

    expect(prepared.completion?.mode).toBe('gated');
    expect(prepared.completion?.crossModelReview?.enabled).toBe(true);
  });

  it('preserves an explicit crossModelReview choice (disabled) without forcing the default', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: {
        ...defaultLoopConfig(workspace, 'g').completion,
        verifyCommand: '',
        mode: 'gated',
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 60, reviewDepth: 'structured' },
      },
    }));

    expect(prepared.completion?.crossModelReview?.enabled).toBe(false);
  });

  it('rejects operator-reviewed completion without a spend cap', async () => {
    await expect(
      prepareLoopStartConfig(mkConfig({
        caps: { ...defaultLoopConfig(workspace, 'g').caps, maxCostCents: null },
        completion: {
          ...defaultLoopConfig(workspace, 'g').completion,
          verifyCommand: '',
          allowOperatorReviewedCompletion: true,
        },
      })),
    ).rejects.toThrow(/spend cap/i);
  });

  it('allows operator-reviewed completion with a spend cap', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      caps: { ...defaultLoopConfig(workspace, 'g').caps, maxCostCents: 1000 },
      completion: {
        ...defaultLoopConfig(workspace, 'g').completion,
        verifyCommand: '',
        allowOperatorReviewedCompletion: true,
      },
    }));

    // Operator-reviewed: no inference is forced; verify command stays empty.
    expect(prepared.completion?.verifyCommand).toBe('');
  });
});
