import { describe, expect, it } from 'vitest';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import {
  ANTIGRAVITY_REVIEW_FALLBACK_MODELS,
  resolveAntigravityReviewModelPlan,
} from './antigravity-review-model-routing';

const GEMINI_MODEL = 'Gemini 3.5 Flash (Medium)';

function snapshot(gemini5h: number, geminiWeekly: number, thirdParty = 0): ProviderQuotaSnapshot {
  return {
    provider: 'antigravity',
    takenAt: Date.now(),
    source: 'admin-api',
    ok: true,
    windows: [
      {
        kind: 'rolling-window', id: 'antigravity.gemini-5h', label: 'Gemini · 5-hour',
        unit: 'requests', used: gemini5h, limit: 100, remaining: 100 - gemini5h, resetsAt: null,
      },
      {
        kind: 'rolling-window', id: 'antigravity.gemini-weekly', label: 'Gemini · weekly',
        unit: 'requests', used: geminiWeekly, limit: 100, remaining: 100 - geminiWeekly, resetsAt: null,
      },
      {
        kind: 'rolling-window', id: 'antigravity.3p-5h', label: 'Claude/GPT · 5-hour',
        unit: 'requests', used: thirdParty, limit: 100, remaining: 100 - thirdParty, resetsAt: null,
      },
    ],
  };
}

describe('resolveAntigravityReviewModelPlan', () => {
  it('treats either exhausted Gemini gate as requiring the shared third-party pool', () => {
    expect(resolveAntigravityReviewModelPlan(GEMINI_MODEL, snapshot(100, 20))).toEqual([
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET,
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS,
    ]);
    expect(resolveAntigravityReviewModelPlan(GEMINI_MODEL, snapshot(20, 100))).toEqual([
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET,
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS,
    ]);
  });

  it('preserves an explicit non-Gemini selection', () => {
    expect(resolveAntigravityReviewModelPlan(
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS,
      snapshot(100, 100),
    )).toEqual([ANTIGRAVITY_REVIEW_FALLBACK_MODELS.GPT_OSS]);
  });

  it('does not infer exhaustion from a failed quota snapshot', () => {
    expect(resolveAntigravityReviewModelPlan(GEMINI_MODEL, {
      ...snapshot(100, 100),
      ok: false,
      error: 'probe failed',
    })).toEqual([GEMINI_MODEL]);
  });

  it('does not schedule GPT-OSS when the shared Claude/GPT pool is already exhausted', () => {
    expect(resolveAntigravityReviewModelPlan(GEMINI_MODEL, snapshot(100, 20, 100))).toEqual([
      ANTIGRAVITY_REVIEW_FALLBACK_MODELS.SONNET,
    ]);
  });
});
