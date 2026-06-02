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
  it('defaults the completion gate to fresh-eyes cross-model review when no verify command is supplied (no longer infers npm run verify)', async () => {
    // Even with a package.json "verify" script present, we no longer infer or
    // force it — the default authority is the fresh-eyes review.
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { verify: 'npm test' } }));

    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '' },
    }));

    expect(prepared.completion?.verifyCommand ?? '').toBe('');
    expect(prepared.completion?.crossModelReview?.enabled).toBe(true);
  });

  it('keeps an explicit verify command untouched (no inference, no review default)', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: 'make check' },
    }));

    expect(prepared.completion?.verifyCommand).toBe('make check');
  });

  it('does not throw when no verify command and not operator-reviewed — defaults to fresh-eyes review', async () => {
    // No package.json / verifier in the workspace: previously this threw; now
    // the loop can start with the fresh-eyes review as its completion authority.
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '' },
    }));

    expect(prepared.completion?.crossModelReview?.enabled).toBe(true);
    expect(prepared.completion?.verifyCommand ?? '').toBe('');
  });

  it('preserves an explicit crossModelReview choice (disabled) without forcing the default', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: {
        ...defaultLoopConfig(workspace, 'g').completion,
        verifyCommand: '',
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
