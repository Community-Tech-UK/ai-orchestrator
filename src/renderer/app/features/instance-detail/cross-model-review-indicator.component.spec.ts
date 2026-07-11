import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggregatedReview, ReviewResult } from '../../../../shared/types/cross-model-review.types';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { CrossModelReviewIndicatorComponent } from './cross-model-review-indicator.component';

function result(reviewerId: string, source: 'remote' | 'local' | undefined, concern = false): ReviewResult {
  return {
    reviewerId,
    ...(source ? { source } : {}),
    reviewType: 'structured',
    scores: {
      correctness: { reasoning: concern ? 'problem' : 'ok', score: concern ? 2 : 4, issues: concern ? ['problem'] : [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: concern ? 'CONCERNS' : 'APPROVE',
    summary: concern ? 'Concern.' : 'Approved.',
    timestamp: 1,
    durationMs: 1,
    parseSuccess: true,
  };
}

function review(reviews: ReviewResult[], localReviewer?: AggregatedReview['localReviewer']): AggregatedReview {
  return {
    id: 'review-1', instanceId: 'inst-1', outputType: 'code', reviewDepth: 'structured',
    reviews, ...(localReviewer ? { localReviewer } : {}), hasDisagreement: false, timestamp: 1,
  };
}

describe('CrossModelReviewIndicatorComponent local review authority', () => {
  const current = signal<AggregatedReview | undefined>(undefined);
  const service = {
    status: signal({ enabled: true, reviewers: [], pendingReviews: 0 }),
    pendingInstances: signal(new Set<string>()),
    skippedInstances: signal(new Set<string>()),
    getReviewForInstance: vi.fn(() => current()),
  };

  beforeEach(async () => {
    current.set(undefined);
    service.getReviewForInstance.mockClear();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [{ provide: CrossModelReviewIpcService, useValue: service }],
    }).compileComponents();
  });

  it('does not render a green Verified state from a local-only clean review', () => {
    current.set(review([result('local:qwen', 'local')], {
      reviewerId: 'local:qwen', source: 'local', status: 'used', model: 'qwen',
    }));
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewIndicatorComponent());
    (component as unknown as { instanceId: ReturnType<typeof signal<string>> }).instanceId = signal('inst-1');

    expect(component.isVerified()).toBe(false);
    expect(component.hasLocalAdvisory()).toBe(true);
    expect(component.tooltip()).toContain('advisory');
  });

  it('treats a legacy source-less remote approval as authoritative while noting local failure', () => {
    current.set(review([result('codex', undefined)], {
      reviewerId: 'local-model', source: 'local', status: 'failed', reason: 'parse failed',
    }));
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewIndicatorComponent());
    (component as unknown as { instanceId: ReturnType<typeof signal<string>> }).instanceId = signal('inst-1');

    expect(component.isVerified()).toBe(true);
    expect(component.tooltip()).toContain('Local reviewer failed');
  });
});
