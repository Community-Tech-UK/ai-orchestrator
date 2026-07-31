import { describe, expect, it } from 'vitest';
import {
  buildAngleCacheKey,
  buildReviewAngleCacheHook,
  computeRequiredCoverageMet,
  getCachedAngle,
  getReviewCoverageReport,
  MAX_TRACKED_REVIEW_ANGLE_CACHE_ENTRIES,
  MAX_TRACKED_REVIEW_COVERAGE_REPORTS,
  persistReviewCoverageReport,
  storeCachedAngle,
} from './review-coverage';
import type { LoopReviewAngleCoverageEntry, LoopState } from '../../shared/types/loop.types';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';

/** These functions only touch `reviewCoverageReports`/`reviewAngleCache` — a
 *  bare fixture keeps tests focused without a full LoopState. */
function makeState(): LoopState {
  return { reviewCoverageReports: undefined, reviewAngleCache: undefined } as unknown as LoopState;
}

const BASE_KEY_INPUT = {
  promptVersion: 'pv1',
  reviewerProvider: 'gemini',
  model: 'gemini-3',
  angleId: 'correctness',
  rulesHash: 'none',
  workHash: 'wh1',
};

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    reviewerId: 'gemini',
    reviewType: 'structured',
    scores: {
      correctness: { reasoning: 'ok', score: 4, issues: [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: 'APPROVE',
    summary: 'clean',
    timestamp: 1,
    durationMs: 1,
    parseSuccess: true,
    ...overrides,
  };
}

describe('buildAngleCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(buildAngleCacheKey(BASE_KEY_INPUT)).toBe(buildAngleCacheKey({ ...BASE_KEY_INPUT }));
  });

  it('changes when any single key component changes', () => {
    const base = buildAngleCacheKey(BASE_KEY_INPUT);
    const variants: Partial<typeof BASE_KEY_INPUT>[] = [
      { promptVersion: 'pv2' },
      { reviewerProvider: 'codex' },
      { model: 'gemini-4' },
      { angleId: 'security' },
      { rulesHash: 'some-other-hash' },
      { workHash: 'wh2' },
    ];
    for (const variant of variants) {
      const key = buildAngleCacheKey({ ...BASE_KEY_INPUT, ...variant });
      expect(key).not.toBe(base);
    }
  });
});

describe('computeRequiredCoverageMet', () => {
  const angle = (over: Partial<LoopReviewAngleCoverageEntry>): LoopReviewAngleCoverageEntry => ({
    angle: 'correctness',
    status: 'used',
    findingCount: 0,
    required: true,
    ...over,
  });

  it('is vacuously true with no angles at all', () => {
    expect(computeRequiredCoverageMet([])).toBe(true);
  });

  it('is vacuously true when nothing is required (e.g. only the local advisory pass)', () => {
    expect(computeRequiredCoverageMet([angle({ required: false, status: 'used' })])).toBe(true);
  });

  it('is true when every required angle is used or cached', () => {
    expect(computeRequiredCoverageMet([
      angle({ status: 'used' }),
      angle({ status: 'cached' }),
      angle({ required: false, status: 'failed' }),
    ])).toBe(true);
  });

  it('is false when a required angle failed', () => {
    expect(computeRequiredCoverageMet([angle({ status: 'used' }), angle({ status: 'failed' })])).toBe(false);
  });

  it('is false when a required angle parse_failed', () => {
    expect(computeRequiredCoverageMet([angle({ status: 'parse_failed' })])).toBe(false);
  });

  it('is false when a required angle was skipped', () => {
    expect(computeRequiredCoverageMet([angle({ status: 'skipped' })])).toBe(false);
  });
});

describe('persistReviewCoverageReport / getReviewCoverageReport', () => {
  it('round-trips a report by reviewAttemptId', () => {
    const state = makeState();
    persistReviewCoverageReport(state, {
      reviewAttemptId: 'fer_1',
      createdAt: 1,
      angles: [],
      requiredCoverageMet: true,
    });

    expect(getReviewCoverageReport(state, 'fer_1')?.requiredCoverageMet).toBe(true);
    expect(getReviewCoverageReport(state, 'missing')).toBeUndefined();
  });

  it('evicts the oldest report once the bound is exceeded, keeping insertion order', () => {
    const state = makeState();
    for (let i = 0; i < MAX_TRACKED_REVIEW_COVERAGE_REPORTS + 2; i++) {
      persistReviewCoverageReport(state, {
        reviewAttemptId: `fer_${i}`,
        createdAt: i,
        angles: [],
        requiredCoverageMet: true,
      });
    }
    const keys = Object.keys(state.reviewCoverageReports ?? {});
    expect(keys).toHaveLength(MAX_TRACKED_REVIEW_COVERAGE_REPORTS);
    expect(keys).not.toContain('fer_0');
    expect(keys).toContain(`fer_${MAX_TRACKED_REVIEW_COVERAGE_REPORTS + 1}`);
  });
});

describe('getCachedAngle / storeCachedAngle', () => {
  it('round-trips a cached angle by cache key and strips rawResponse', () => {
    const state = makeState();
    const key = buildAngleCacheKey(BASE_KEY_INPUT);
    storeCachedAngle(state, {
      cacheKey: key,
      angle: 'correctness',
      reviewerProvider: 'gemini',
      model: 'gemini-3',
      review: makeReview({ rawResponse: 'huge raw text nobody needs to cache' }),
    });

    const entry = getCachedAngle(state, key);
    expect(entry?.review.summary).toBe('clean');
    expect(entry?.review).not.toHaveProperty('rawResponse');
    expect(getCachedAngle(state, 'nonexistent')).toBeUndefined();
  });

  it('evicts the oldest cache entry once the bound is exceeded', () => {
    const state = makeState();
    for (let i = 0; i < MAX_TRACKED_REVIEW_ANGLE_CACHE_ENTRIES + 2; i++) {
      storeCachedAngle(state, {
        cacheKey: `key-${i}`,
        angle: 'correctness',
        reviewerProvider: 'gemini',
        review: makeReview(),
      });
    }
    const keys = Object.keys(state.reviewAngleCache ?? {});
    expect(keys).toHaveLength(MAX_TRACKED_REVIEW_ANGLE_CACHE_ENTRIES);
    expect(keys).not.toContain('key-0');
  });
});

describe('buildReviewAngleCacheHook', () => {
  it('lookup misses on an empty cache', () => {
    const state = makeState();
    const hook = buildReviewAngleCacheHook(state);
    expect(hook.lookup(BASE_KEY_INPUT)).toBeUndefined();
  });

  it('store then lookup returns the cached review with an activation reason', () => {
    const state = makeState();
    const hook = buildReviewAngleCacheHook(state);
    const review = makeReview({ summary: 'cached clean verdict' });

    hook.store({ ...BASE_KEY_INPUT, review });
    const hit = hook.lookup(BASE_KEY_INPUT);

    expect(hit?.review.summary).toBe('cached clean verdict');
    expect(hit?.activationReason).toMatch(/reused a cached clean angle/);
  });

  it('a changed workHash (the reviewed content changed) misses even after a store', () => {
    const state = makeState();
    const hook = buildReviewAngleCacheHook(state);
    hook.store({ ...BASE_KEY_INPUT, review: makeReview() });

    expect(hook.lookup({ ...BASE_KEY_INPUT, workHash: 'a-different-work-hash' })).toBeUndefined();
  });
});
