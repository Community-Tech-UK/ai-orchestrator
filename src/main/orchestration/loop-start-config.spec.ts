/**
 * LF-3a (loopfixex §13) — loop start-config preparation.
 *
 * Verifies the two start-time safety rules: verify-command inference (surfaced
 * back so the renderer shows what gates completion) and the cost-cap
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
  it('surfaces the inferred verify command when none is supplied', async () => {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { verify: 'npm test' } }));

    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '' },
    }));

    expect(prepared.completion?.verifyCommand).toBe('npm run verify');
  });

  it('keeps an explicit verify command untouched (no inference)', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: 'make check' },
    }));

    expect(prepared.completion?.verifyCommand).toBe('make check');
  });

  it('throws when no verify command can be inferred and the loop is not operator-reviewed', async () => {
    // No package.json / verifier in the workspace.
    await expect(
      prepareLoopStartConfig(mkConfig({
        completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '' },
      })),
    ).rejects.toThrow(/could not infer a verify command/i);
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
