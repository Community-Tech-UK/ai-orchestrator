import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggregatedReview, ReviewResult, CrossModelReviewStatus } from '../../../../shared/types/cross-model-review.types';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { CrossModelReviewIndicatorComponent } from './cross-model-review-indicator.component';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

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
    status: signal<CrossModelReviewStatus>({ enabled: true, reviewers: [], pendingReviews: 0 }),
    pendingInstances: signal(new Set<string>()),
    skippedInstances: signal(new Set<string>()),
    getReviewForInstance: vi.fn(() => current()),
  };

  beforeEach(async () => {
    current.set(undefined);
    service.pendingInstances.set(new Set<string>()); service.skippedInstances.set(new Set<string>());
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 0 });
    service.getReviewForInstance.mockClear();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [{ provide: CrossModelReviewIpcService, useValue: service }],
    }).compileComponents();
  });

  it('renders the daily limit badge and exact tooltip', () => {
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 0, dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } });
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Second opinion: limit reached');
    expect(fixture.componentInstance.tooltip()).toBe(`${copyFor('secondOpinion.limitReached')} 20 of 20 used today. Resets at midnight.`);
  });

  it.each([false, true])('keeps the completed verdict visible at the daily limit (concerns: %s)', concern => {
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 0,
      dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } });
    current.set({ ...review([result('codex', 'remote', concern)]), turnSeq: 3 });
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(concern ? 'Second opinion: 1 concern' : 'Second opinion: ✓');
    expect(fixture.nativeElement.querySelector('.review-indicator').classList).not.toContain('skipped');
    expect(fixture.componentInstance.tooltip()).toContain(copyFor(concern ? 'secondOpinion.concerns' : 'secondOpinion.verified'));
    expect(fixture.componentInstance.tooltip()).toContain('Reviewed turn 3');
    expect(fixture.componentInstance.tooltip()).toContain('20 of 20 used today');
  });

  it('shows a genuinely running review ahead of both an older result and the daily cap', () => {
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 1,
      dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } });
    current.set(review([result('codex', 'remote')]));
    service.pendingInstances.set(new Set(['inst-1']));
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.textContent).toContain('Second opinion: checking');
    expect(button.classList).toContain('reviewing');
    expect(button.classList).not.toContain('skipped');
    expect(button.classList).not.toContain('verified');
    expect(fixture.componentInstance.tooltip()).toContain(copyFor('secondOpinion.checking'));
    const clicked = vi.fn(); fixture.componentInstance.indicatorClicked.subscribe(clicked);
    button.click(); expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(['checking', 'verified', 'concerns', 'localOnly', 'failed', 'skipped', 'limitReached'] as const)('binds the registered %s explanation to the actual tooltip', state => {
    if (state === 'checking') service.pendingInstances.set(new Set(['inst-1']));
    if (state === 'skipped') service.skippedInstances.set(new Set(['inst-1']));
    if (state === 'limitReached') service.status.set({ enabled: true, reviewers: [], pendingReviews: 0,
      dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } });
    if (state === 'verified' || state === 'concerns') {
      current.set({ ...review([result('codex', 'remote', state === 'concerns')]), turnSeq: 3 });
    }
    if (state === 'localOnly') current.set(review([result('local', 'local')]));
    if (state === 'failed') current.set(review([], { reviewerId: 'local', source: 'local', status: 'failed', reason: 'unavailable' }));
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    const trigger = fixture.debugElement.query(By.directive(AioTooltipDirective));
    expect(trigger.injector.get(AioTooltipDirective).appTooltip()).toContain(copyFor(`secondOpinion.${state}`));
    expect(fixture.nativeElement.textContent).toContain('Second opinion:');
    if (state === 'verified' || state === 'concerns') expect(fixture.componentInstance.tooltip()).toContain('Reviewed turn 3');
  });

  it('shows a manual second opinion when automatic reviews are off', () => {
    service.status.set({ enabled: false, reviewers: [], pendingReviews: 0 });
    current.set(review([result('codex', 'remote', true), result('gemini', 'remote', true)]));
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Second opinion: 2 concerns');
  });
  it('uses words for skipped and a neutral class for the daily limit', () => {
    service.skippedInstances.set(new Set(['inst-1']));
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Second opinion: skipped');
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 0, dailyUsage: { used: 20, limit: 20, resetsAt: 123, limitReached: true } }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.review-indicator').classList).toContain('skipped');
  });

  it('names the reviewed turn', () => {
    current.set({ ...review([result('codex', undefined)]), turnSeq: 3 });
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewIndicatorComponent());
    (component as unknown as { instanceId: ReturnType<typeof signal<string>> }).instanceId = signal('inst-1');
    expect(component.tooltip()).toContain('Reviewed turn 3');
    expect(component.tooltip()).toContain(copyFor('secondOpinion.verified'));
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
    expect(component.tooltip()).toContain(copyFor('secondOpinion.localOnly'));
  });

  it('does not treat a skipped local reviewer as advisory', () => {
    current.set(review([result('codex', undefined)], {
      reviewerId: 'local-model', source: 'local', status: 'skipped', reason: 'unavailable',
    }));
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewIndicatorComponent());
    (component as unknown as { instanceId: ReturnType<typeof signal<string>> }).instanceId = signal('inst-1');

    expect(component.hasLocalAdvisory()).toBe(false);
    expect(component.hasLocalFailure()).toBe(false);
    expect(component.isVerified()).toBe(true);
  });

  it('flags a local-only failure as a failure, not an advisory', () => {
    current.set(review([], {
      reviewerId: 'local-model', source: 'local', status: 'failed', reason: 'endpoint stopped',
    }));
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewIndicatorComponent());
    (component as unknown as { instanceId: ReturnType<typeof signal<string>> }).instanceId = signal('inst-1');

    expect(component.hasLocalFailure()).toBe(true);
    expect(component.hasLocalAdvisory()).toBe(false);
    expect(component.isVerified()).toBe(false);
    expect(component.tooltip()).toContain(copyFor('secondOpinion.failed'));
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
  it('shows the measured daily second-opinion count while a review is pending', () => {
    service.status.set({ enabled: true, reviewers: [], pendingReviews: 1,
      dailyUsage: { used: 8, limit: 20, resetsAt: 123, limitReached: false } });
    service.pendingInstances.set(new Set(['inst-1']));
    const fixture = TestBed.createComponent(CrossModelReviewIndicatorComponent);
    fixture.componentRef.setInput('instanceId', 'inst-1'); fixture.detectChanges();
    expect(fixture.componentInstance.tooltip()).toContain('Second opinions today: 8 of 20');
  });
});
