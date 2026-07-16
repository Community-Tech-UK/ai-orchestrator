/**
 * LF-3a (loopfixex §13) — loop start-config preparation.
 *
 * Verifies the start-time safety rules: user-started loops default to
 * review-driven self-review, explicit gated/no-verify loops default to the
 * cross-model gate, and operator-reviewed loops require an estimated usage cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLoopStartConfig, attachNextObjectivePlanner } from './loop-start-config';
import { defaultLoopConfig, type LoopConfig } from '../../shared/types/loop.types';
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
    // WS6: the neutral base carries a machine verify command so tests whose
    // subject is NOT the verification-authority policy satisfy it by default.
    completion: { ...base.completion, verifyCommand: 'npm test' },
    ...overrides,
  } as LoopConfigInput;
}

describe('prepareLoopStartConfig (LF-3a)', () => {
  it('defaults user-started loops to review-driven (self-review) — no auto cross-model review, no inferred verify command', async () => {
    // Even with a package.json "verify" script present, we no longer infer or
    // force it. The default is review-driven self-review; cross-model review is
    // an opt-in, so it must NOT be auto-enabled. (Investigation goal: WS6
    // allows review/report authority without a machine verify command.)
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { verify: 'npm test' } }));

    const prepared = await prepareLoopStartConfig(mkConfig({
      goalIntent: 'investigation',
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

  it('WS6: REJECTS an implementation loop with no verify command and no operator-reviewed authority', async () => {
    await expect(
      prepareLoopStartConfig(mkConfig({
        completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: undefined },
      })),
    ).rejects.toThrow(/verification authority/i);
  });

  it('WS6: an INVESTIGATION loop may run with review/report authority (no verify command)', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      initialPrompt: 'investigate why startup is slow and report the root cause',
      goalIntent: undefined,
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: undefined },
    }));

    expect(prepared.goalIntent).toBe('investigation');
    expect(prepared.completion?.mode).toBe('review-driven');
    expect(prepared.completion?.verifyCommand ?? '').toBe('');
  });

  it('WS6: an ambiguous goal is classified implementation and held to the policy', async () => {
    await expect(
      prepareLoopStartConfig(mkConfig({
        initialPrompt: 'goal',
        goalIntent: undefined,
        completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: undefined },
      })),
    ).rejects.toThrow(/verification authority/i);
  });

  it('WS6: start-boundary — a rejected config never reaches loop start (the reject IS the boundary)', async () => {
    // prepareLoopStartConfig is awaited by the IPC handler BEFORE
    // LoopCoordinator.startLoop; a rejection here means no adapter or
    // coordinator invocation can occur. Prove the promise rejects rather
    // than resolving into a config that could be passed onward.
    let prepared: unknown = null;
    try {
      prepared = await prepareLoopStartConfig(mkConfig({
        completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '' },
      }));
    } catch {
      // expected
    }
    expect(prepared).toBeNull();
  });

  it('honours an explicit gated mode and defaults its authority to fresh-eyes cross-model review when no verify command', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      goalIntent: 'investigation',
      completion: { ...defaultLoopConfig(workspace, 'g').completion, verifyCommand: '', mode: 'gated' },
    }));

    expect(prepared.completion?.mode).toBe('gated');
    expect(prepared.completion?.crossModelReview?.enabled).toBe(true);
  });

  it('preserves an explicit crossModelReview choice (disabled) without forcing the default', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      goalIntent: 'investigation',
      completion: {
        ...defaultLoopConfig(workspace, 'g').completion,
        verifyCommand: '',
        mode: 'gated',
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 60, reviewDepth: 'structured' },
      },
    }));

    expect(prepared.completion?.crossModelReview?.enabled).toBe(false);
  });

  it('rejects operator-reviewed completion without an estimated usage cap', async () => {
    await expect(
      prepareLoopStartConfig(mkConfig({
        caps: { ...defaultLoopConfig(workspace, 'g').caps, maxCostCents: null },
        completion: {
          ...defaultLoopConfig(workspace, 'g').completion,
          verifyCommand: '',
          allowOperatorReviewedCompletion: true,
        },
      })),
    ).rejects.toThrow(/usage cap/i);
  });

  it('allows operator-reviewed completion with an estimated usage cap', async () => {
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

  it('attaches a runtime planner when serializable next-objective planning is enabled', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      nextObjectivePlanning: { enabled: true, cadence: 2 },
    } as unknown as Partial<LoopConfigInput>));

    expect((prepared as { nextObjectivePlanning?: { enabled: boolean; cadence: number } }).nextObjectivePlanning).toEqual({
      enabled: true,
      cadence: 2,
    });
    expect(prepared.nextObjectivePlanner).toBeTypeOf('function');
  });

  it('defaults user-started audit to gate, record preflight, and prompted plan packets for substantial loops', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig());

    expect(prepared.audit).toEqual({
      finalAuditMode: 'gate',
      preflightMode: 'record',
      planPacketMode: 'prompted',
      cleanlinessScan: true,
    });
  });

  it('keeps plan packets off by default for short low-iteration loops without a plan file', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      caps: { ...defaultLoopConfig(workspace, 'g').caps, maxIterations: 3 },
    }));

    expect(prepared.audit?.planPacketMode).toBe('off');
  });

  it('defaults plan packets to prompted for long prompts and plan-file loops', async () => {
    const longPrompt = 'x'.repeat(800);
    const byPrompt = await prepareLoopStartConfig(mkConfig({
      initialPrompt: longPrompt,
      caps: { ...defaultLoopConfig(workspace, longPrompt).caps, maxIterations: 3 },
    }));
    const byPlanFile = await prepareLoopStartConfig(mkConfig({
      planFile: 'PLAN.md',
      caps: { ...defaultLoopConfig(workspace, 'g').caps, maxIterations: 3 },
    }));

    expect(byPrompt.audit?.planPacketMode).toBe('prompted');
    expect(byPlanFile.audit?.planPacketMode).toBe('prompted');
  });

  it('preserves explicit user-started audit overrides', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      audit: {
        finalAuditMode: 'observe',
        preflightMode: 'block',
        planPacketMode: 'off',
        cleanlinessScan: false,
      },
    }));

    expect(prepared.audit).toEqual({
      finalAuditMode: 'observe',
      preflightMode: 'block',
      planPacketMode: 'off',
      cleanlinessScan: false,
    });
  });

  it('uses fresh-child context only when the Phase 4 fresh-session gate is enabled', async () => {
    const prepared = await prepareLoopStartConfig(mkConfig({
      contextStrategy: 'same-session',
      phase4: {
        commitRatchet: {
          enabled: false,
          worktreeOnly: true,
          keepPolicy: 'score-improvement',
          resetOnRegression: true,
        },
        freshSessionPerIteration: { enabled: true },
        subagentContracts: {
          enabled: false,
          maxDepth: 1,
          requireNonOverlappingWriteScopes: true,
        },
        toolRwLocks: { enabled: false },
      },
    } as unknown as Partial<LoopConfigInput>));

    expect(prepared.contextStrategy).toBe('fresh-child');
  });
});

describe('attachNextObjectivePlanner', () => {
  const base = (overrides: Partial<LoopConfig> = {}): Partial<LoopConfig> & { initialPrompt: string; workspaceCwd: string } => ({
    initialPrompt: 'goal',
    workspaceCwd: '/tmp/project',
    ...overrides,
  });

  it('re-attaches the planner when enabled but missing (rehydrated config)', () => {
    const result = attachNextObjectivePlanner(base({
      nextObjectivePlanning: { enabled: true, cadence: 1 },
    }));
    expect(result.nextObjectivePlanner).toBeTypeOf('function');
  });

  it('leaves a config without next-objective planning untouched', () => {
    const result = attachNextObjectivePlanner(base({
      nextObjectivePlanning: { enabled: false, cadence: 1 },
    }));
    expect(result.nextObjectivePlanner).toBeUndefined();
  });

  it('does not overwrite an already-attached planner', () => {
    const planner = (async () => null) as unknown as NonNullable<LoopConfig['nextObjectivePlanner']>;
    const result = attachNextObjectivePlanner(base({
      nextObjectivePlanning: { enabled: true, cadence: 1 },
      nextObjectivePlanner: planner,
    }));
    expect(result.nextObjectivePlanner).toBe(planner);
  });
});
