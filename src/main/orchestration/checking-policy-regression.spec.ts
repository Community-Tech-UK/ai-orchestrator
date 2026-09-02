import { describe, expect, it, vi } from 'vitest';

/**
 * Regression cover for the defect this policy exists to fix.
 *
 * Before: the loop's fresh-eyes gate never told the headless review path who
 * built the work, and that path filled the blank with `?? 'claude'`. A Codex or
 * enterprise-Copilot build therefore had CLAUDE — the most useful checker —
 * barred from reviewing it, while Codex remained free to review its own work.
 *
 * These tests pin the two halves of the fix that are cheapest to get wrong
 * again: the gate passing the builder identity, and the headless resolver
 * refusing to invent one.
 */

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      crossModelReviewModelByProvider: {},
      crossModelReviewProviders: ['claude', 'codex', 'cursor'],
      crossModelReviewMaxReviewers: 2,
    }),
  }),
}));

import { resolveCheckerPlan } from '../review/checker-plan';
import type { WorkspaceCopilotScope } from '../providers/copilot/copilot-account-routing-service';

const NO_SCOPE: WorkspaceCopilotScope = { kind: 'none' };

describe('checking policy — the ?? \'claude\' regression', () => {
  it('an unknown implementer constrains nothing (Claude is NOT barred)', () => {
    const plan = resolveCheckerPlan(['claude', 'codex'], {
      context: 'regression',
    }, {
      classifyScope: () => NO_SCOPE,
      resolveProviderModel: () => undefined,
    });

    expect(plan.candidates.map((candidate) => candidate.provider)).toEqual(['claude', 'codex']);
  });

  it('a Codex build on an OpenAI model is not checked by another OpenAI model', () => {
    const plan = resolveCheckerPlan(['copilot'], {
      implementerProvider: 'codex',
      implementerModel: 'gpt-5.6-terra',
      context: 'regression',
    }, {
      classifyScope: () => NO_SCOPE,
      // The configured Copilot reviewer model is also OpenAI — the collision.
      resolveProviderModel: () => 'gpt-5.5',
    });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.model).toBe('claude-opus-5');
    expect(plan.candidates[0]?.rationale).toBe('family-diverse');
  });

  it('an enterprise-Copilot build is checked on the SAME seat, different family', () => {
    const plan = resolveCheckerPlan(['claude', 'codex'], {
      implementerProvider: 'copilot',
      implementerModel: 'claude-opus-5',
      workingDirectory: '/work/ebrd/repo',
      context: 'regression',
    }, {
      classifyScope: () => ({
        kind: 'protected',
        profileId: 'work',
        profileLabel: 'Work',
        accountKind: 'enterprise',
        automationPolicy: 'allow-routed',
      }),
      resolveProviderModel: () => undefined,
    });

    expect(plan.candidates.every((candidate) => candidate.provider === 'copilot')).toBe(true);
    expect(plan.candidates.every((candidate) => candidate.copilotProfileId === 'work')).toBe(true);
    // Nothing Anthropic — the implementer's family — and nothing off the seat.
    expect(plan.candidates.map((candidate) => candidate.model)).not.toContain('claude-opus-5');
  });
});

describe('loop fresh-eyes gate wiring', () => {
  it('hands the builder provider and model to the reviewer', async () => {
    const { runFreshEyesReviewGate } = await import('./loop-coordinator-completion-gates');
    const { defaultLoopConfig } = await import('../../shared/types/loop.types');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const workspace = mkdtempSync(join(tmpdir(), 'checking-policy-'));
    const config = defaultLoopConfig(workspace, 'goal');
    config.provider = 'codex';
    config.completion.crossModelReview = {
      enabled: true,
      blockingSeverities: ['critical', 'high'],
      timeoutSeconds: 5,
      reviewDepth: 'structured',
    };

    let received: { builderProvider?: string; builderModel?: string } | undefined;
    await runFreshEyesReviewGate({
      state: {
        id: 'run-1',
        config,
        uncompletedPlanFilesAtStart: [],
      } as never,
      signalId: 'self-declared',
      iteration: {
        seq: 1,
        stage: 'IMPLEMENT',
        outputExcerpt: 'done',
        filesChanged: [],
        model: 'gpt-5.6-terra',
      } as never,
      verifyOutput: '',
      reviewer: async (input) => {
        received = input;
        return { findings: [], reviewersUsed: ['claude'], summary: 'clean' };
      },
      emit: () => undefined,
      setConvergenceNote: () => undefined,
    });

    // The defect: neither of these was passed, so the headless path assumed
    // Claude built the work and barred Claude from checking it.
    expect(received?.builderProvider).toBe('codex');
    expect(received?.builderModel).toBe('gpt-5.6-terra');
  });
});

/**
 * Gate pass 6: the in-session review path used to collapse a licence-pinned plan
 * by PROVIDER NAME. Every candidate in that branch is `copilot` by design, so
 * every checker after the first was silently discarded and
 * `crossModelReviewMaxReviewers` was ignored — a 2-reviewer config produced 1.
 *
 * This asserts the property at the seam that broke: distinct (provider, model)
 * checkers survive as distinct dispatches.
 */
describe('licence-pinned plans keep every checker', () => {
  it('produces N distinct copilot checkers for N requested reviewers', async () => {
    const { resolveCheckerPlan: plan } = await import('../review/checker-plan');

    const result = plan(['claude', 'codex'], {
      implementerProvider: 'copilot',
      implementerModel: 'claude-opus-5',
      workingDirectory: '/work/ebrd/repo',
      context: 'regression',
    }, {
      classifyScope: () => ({
        kind: 'protected',
        profileId: 'work',
        profileLabel: 'Work',
        accountKind: 'enterprise',
        automationPolicy: 'allow-routed',
      }),
      resolveProviderModel: () => undefined,
    });

    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.candidates.map((c) => c.model)).size).toBe(2);
    // Collapsing these by provider name is what the defect did.
    expect(new Set(result.candidates.map((c) => c.provider)).size).toBe(1);
  });

  it('dispatches one review per candidate, not one per provider', async () => {
    // The seam itself: collectSuccessfulReviews must iterate candidates.
    const { CrossModelReviewService } = await import('./cross-model-review-service');
    const service = CrossModelReviewService.getInstance() as unknown as {
      collectSuccessfulReviews: (
        request: unknown, checkers: unknown[], timeout: number, signal: AbortSignal,
      ) => Promise<unknown[]>;
      executeOneReview: unknown;
    };
    const seen: Array<string | undefined> = [];
    service.executeOneReview = async (
      _r: unknown, cliType: string, _t: number, _s: AbortSignal, model?: string,
    ) => {
      seen.push(`${cliType}:${model}`);
      return null;
    };

    await service.collectSuccessfulReviews(
      { id: 'r', instanceId: 'i', primaryProvider: 'copilot', workingDirectory: '/w', licencePinned: true },
      [
        { provider: 'copilot', model: 'gpt-5.6-terra', rationale: 'licence-pinned' },
        { provider: 'copilot', model: 'grok-4.6', rationale: 'licence-pinned' },
      ],
      5,
      new AbortController().signal,
    );

    expect(seen).toEqual(['copilot:gpt-5.6-terra', 'copilot:grok-4.6']);
  });
});
