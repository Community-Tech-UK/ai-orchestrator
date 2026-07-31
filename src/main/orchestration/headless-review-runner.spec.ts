import { describe, expect, it, vi } from 'vitest';
import { runHeadlessReviewCommand, type HeadlessReviewRunnerDependencies } from './headless-review-runner';
import type { HeadlessReviewAngleCacheHook, HeadlessReviewRequest, ReviewExecutionHost } from '../review/review-execution-host';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import { angleForReviewer, promptVersionForAngle } from './review-prompts';
import { NO_RULES_HASH } from './review-coverage';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ crossModelReviewModelByProvider: {} }) }),
}));

function reviewerJson(issue: string): string {
  return JSON.stringify({
    correctness: { reasoning: 'The diff misses a null guard.', score: 2, issues: [issue] },
    completeness: { reasoning: 'ok', score: 4, issues: [] },
    security: { reasoning: 'ok', score: 4, issues: [] },
    consistency: { reasoning: 'ok', score: 4, issues: [] },
    overall_verdict: 'CONCERNS',
    summary: 'One correctness concern.',
  });
}

function baseDeps(overrides: Partial<HeadlessReviewRunnerDependencies> = {}): HeadlessReviewRunnerDependencies {
  return {
    host: { dispatchReviewerPrompt: vi.fn(async () => reviewerJson('finding')) } as unknown as ReviewExecutionHost,
    resolveReviewers: async () => ['gemini'],
    localEnabled: false,
    createLocalPlan: () => ({
      run: async () => ({ status: 'skipped', reason: 'local disabled in this test' }),
      participant: () => ({ reviewerId: 'local-model', source: 'local', status: 'skipped', reason: 'local disabled in this test' }),
    }),
    ...overrides,
  };
}

function baseRequest(overrides: Partial<HeadlessReviewRequest> = {}): HeadlessReviewRequest {
  return {
    target: 'HEAD',
    cwd: process.cwd(),
    content: 'diff --git a/src/a.ts b/src/a.ts',
    taskDescription: 'Review the change.',
    reviewDepth: 'structured',
    ...overrides,
  };
}

/** Builds a minimal, spy-instrumented cache hook — never hits real LoopState. */
function fakeCacheHook(hit?: { review: ReviewResult; activationReason: string }): {
  hook: HeadlessReviewAngleCacheHook;
  lookup: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
} {
  const lookup = vi.fn(() => hit);
  const store = vi.fn();
  return { hook: { lookup, store }, lookup, store };
}

describe('runHeadlessReviewCommand — WS-B9 coverage + cache', () => {
  it('assigns the deterministic angle-by-index and reports used status/model/findingCount', async () => {
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('null check missing'));
    const deps = baseDeps({
      host: { dispatchReviewerPrompt } as unknown as ReviewExecutionHost,
      resolveReviewers: async () => ['gemini', 'codex'],
    });

    const result = await runHeadlessReviewCommand(baseRequest(), deps);

    expect(result.reviewers).toEqual([
      { provider: 'gemini', status: 'used', angle: angleForReviewer(0).id, required: true, findingCount: 1 },
      { provider: 'codex', status: 'used', angle: angleForReviewer(1).id, required: true, findingCount: 1 },
    ]);
  });

  it('reports a reviewer whose output cannot be parsed as parse_failed, never cached', async () => {
    const { hook, store } = fakeCacheHook();
    const dispatchReviewerPrompt = vi.fn(async () => 'not json at all');
    const deps = baseDeps({ host: { dispatchReviewerPrompt } as unknown as ReviewExecutionHost });

    const result = await runHeadlessReviewCommand(baseRequest({ reviewCache: hook }), deps);

    expect(result.reviewers).toEqual([expect.objectContaining({ provider: 'gemini', status: 'parse_failed' })]);
    expect(store).not.toHaveBeenCalled();
  });

  it('reports a reviewer whose dispatch throws as failed (distinct from parse_failed), never cached', async () => {
    const { hook, store } = fakeCacheHook();
    const dispatchReviewerPrompt = vi.fn(async () => { throw new Error('transport exploded'); });
    const deps = baseDeps({ host: { dispatchReviewerPrompt } as unknown as ReviewExecutionHost });

    const result = await runHeadlessReviewCommand(baseRequest({ reviewCache: hook }), deps);

    expect(result.reviewers).toEqual([
      expect.objectContaining({ provider: 'gemini', status: 'failed', reason: 'transport exploded' }),
    ]);
    expect(store).not.toHaveBeenCalled();
  });

  it('stores a successful angle in the cache keyed on schema/prompt/reviewer/model/angle/rules/workHash', async () => {
    const { hook, store } = fakeCacheHook();
    const deps = baseDeps();
    const content = 'diff --git a/src/a.ts b/src/a.ts\n+const x = 1;';

    await runHeadlessReviewCommand(baseRequest({ content, reviewCache: hook }), deps);

    expect(store).toHaveBeenCalledTimes(1);
    const stored = store.mock.calls[0][0];
    expect(stored.reviewerProvider).toBe('gemini');
    expect(stored.angleId).toBe(angleForReviewer(0).id);
    expect(stored.promptVersion).toBe(promptVersionForAngle('structured', angleForReviewer(0)));
    expect(stored.rulesHash).toBe(NO_RULES_HASH);
    expect(stored.model).toBe('auto');
    expect(typeof stored.workHash).toBe('string');
    expect(stored.review.summary).toBe('One correctness concern.');
  });

  it('a cache hit skips dispatch entirely and reports status cached with the cache activation reason', async () => {
    const cachedReview: ReviewResult = {
      reviewerId: 'gemini',
      reviewType: 'structured',
      scores: {
        correctness: { reasoning: 'ok', score: 4, issues: [] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
      overallVerdict: 'APPROVE',
      summary: 'reused clean verdict',
      timestamp: 1,
      durationMs: 1,
      parseSuccess: true,
    };
    const { hook, lookup } = fakeCacheHook({ review: cachedReview, activationReason: 'reused — unchanged' });
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('should never be called'));
    const deps = baseDeps({ host: { dispatchReviewerPrompt } as unknown as ReviewExecutionHost });

    const result = await runHeadlessReviewCommand(baseRequest({ reviewCache: hook }), deps);

    expect(dispatchReviewerPrompt).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(result.reviewers).toEqual([
      expect.objectContaining({
        provider: 'gemini', status: 'cached', angle: angleForReviewer(0).id, reason: 'reused — unchanged',
      }),
    ]);
    expect(result.summary).toContain('1 reviewer');
  });

  it('behaves exactly as before WS-B9 when no reviewCache is supplied (no lookup/store attempted)', async () => {
    const deps = baseDeps();

    const result = await runHeadlessReviewCommand(baseRequest(), deps);

    expect(result.reviewers).toEqual([
      { provider: 'gemini', status: 'used', angle: angleForReviewer(0).id, required: true, findingCount: 1 },
    ]);
  });

  it('reports the local-model advisory pass as angle local-advisory and never required', async () => {
    const localReview: ReviewResult = {
      reviewerId: 'local:qwen',
      source: 'local',
      reviewType: 'structured',
      scores: {
        correctness: { reasoning: 'ok', score: 4, issues: ['a local concern'] },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
      overallVerdict: 'CONCERNS',
      summary: 'local concern',
      timestamp: 1,
      durationMs: 1,
      parseSuccess: true,
    };
    const deps = baseDeps({
      resolveReviewers: async () => [],
      localEnabled: true,
      createLocalPlan: () => ({
        run: async () => ({ status: 'used', review: localReview, evidencePaths: [] }),
        participant: () => ({ reviewerId: 'local:qwen', source: 'local', status: 'used' }),
      }),
    });

    const result = await runHeadlessReviewCommand(baseRequest(), deps);

    expect(result.reviewers).toEqual([expect.objectContaining({
      provider: 'local-model', angle: 'local-advisory', required: false, findingCount: 1,
    })]);
  });

  it('re-verifies a cached finding\'s anchor against the CURRENT reviewed content — a hit never trusts a stale anchorStatus', async () => {
    const cachedReviewWithStaleAnchor: ReviewResult = {
      reviewerId: 'gemini',
      reviewType: 'structured',
      scores: {
        correctness: {
          reasoning: 'missing guard', score: 2,
          issues: ['Auth check missing.\n#EVIDENCE#\n{"quote":"const guard = checkAuth();"}'],
        },
        completeness: { reasoning: 'ok', score: 4, issues: [] },
        security: { reasoning: 'ok', score: 4, issues: [] },
        consistency: { reasoning: 'ok', score: 4, issues: [] },
      },
      overallVerdict: 'CONCERNS',
      summary: 'one concern',
      timestamp: 1,
      durationMs: 1,
      parseSuccess: true,
    };
    const { hook } = fakeCacheHook({ review: cachedReviewWithStaleAnchor, activationReason: 'reused' });
    const deps = baseDeps();
    // The CURRENT attempt's reviewed content does not contain the cached
    // finding's cited quote at all — the citation is stale/hallucinated for
    // THIS attempt, even though it was cached from a prior one.
    const content = 'diff --git a/src/a.ts b/src/a.ts\n+const totallyDifferent = true;';

    const result = await runHeadlessReviewCommand(baseRequest({ content, reviewCache: hook }), deps);

    expect(result.findings).toContainEqual(expect.objectContaining({
      anchorStatus: 'evidence_unverified',
    }));
  });

  it('a changed reviewed-content work hash misses the cache and dispatches live again', async () => {
    const { hook, lookup } = fakeCacheHook(undefined);
    const dispatchReviewerPrompt = vi.fn(async () => reviewerJson('finding'));
    const deps = baseDeps({ host: { dispatchReviewerPrompt } as unknown as ReviewExecutionHost });

    await runHeadlessReviewCommand(baseRequest({ content: 'diff A', reviewCache: hook }), deps);
    await runHeadlessReviewCommand(baseRequest({ content: 'diff B (materially different)', reviewCache: hook }), deps);

    expect(dispatchReviewerPrompt).toHaveBeenCalledTimes(2);
    const workHashes = lookup.mock.calls.map((call) => call[0].workHash);
    expect(new Set(workHashes).size).toBe(2);
  });
});
