import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AggregatedReview, ReviewResult } from '../../../../shared/types/cross-model-review.types';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { CrossModelReviewPanelComponent } from './cross-model-review-panel.component';

function result(reviewerId: string, source: 'remote' | 'local', concern: boolean): ReviewResult {
  return {
    reviewerId, source, reviewType: 'structured',
    scores: {
      correctness: { reasoning: concern ? 'problem' : 'ok', score: concern ? 2 : 4, issues: concern ? ['problem'] : [] },
      completeness: { reasoning: 'ok', score: 4, issues: [] },
      security: { reasoning: 'ok', score: 4, issues: [] },
      consistency: { reasoning: 'ok', score: 4, issues: [] },
    },
    overallVerdict: concern ? 'REJECT' : 'APPROVE', summary: concern ? 'Concern.' : 'Approved.',
    timestamp: 1, durationMs: 1, parseSuccess: true,
  };
}

function review(reviews: ReviewResult[], localReviewer: AggregatedReview['localReviewer']): AggregatedReview {
  return {
    id: 'review-1', instanceId: 'inst-1', outputType: 'code', reviewDepth: 'structured',
    reviews, localReviewer, hasDisagreement: true, timestamp: 1,
  };
}

describe('CrossModelReviewPanelComponent local review authority', () => {
  const performAction = vi.fn().mockResolvedValue(undefined);
  const dismiss = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    performAction.mockClear();
    dismiss.mockClear();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      providers: [{ provide: CrossModelReviewIpcService, useValue: { performAction, dismiss } }],
    }).compileComponents();
  });

  it("names the session's agent: 'Ask Codex to fix these'", () => {
    const fixture = TestBed.createComponent(CrossModelReviewPanelComponent);
    fixture.componentRef.setInput('review', review([result('gemini', 'remote', true)], undefined));
    fixture.componentRef.setInput('agentName', 'Codex'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Ask Codex to fix these');
    expect(fixture.nativeElement.textContent).toContain('Show all');
    expect(fixture.nativeElement.textContent).toContain('Raw review');
  });

  it('shows local-only concerns as advisory and withholds authoritative actions', async () => {
    const value = review(
      [result('local:qwen', 'local', true)],
      { reviewerId: 'local:qwen', source: 'local', status: 'used', model: 'qwen' },
    );
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewPanelComponent());
    (component as unknown as { review: ReturnType<typeof signal<AggregatedReview | null>> }).review = signal(value);

    expect(component.hasConcerns()).toBe(false);
    expect(component.headerTitle()).toContain('local model only');
    expect(component.localStatusText()).toContain('Local reviewer qwen: used');

    await component.onAction('start-debate');
    expect(performAction).not.toHaveBeenCalled();
  });

  describe('the "ask the session to address it" button', () => {
    function panel(agentName?: string) {
      const value = review([result('codex', 'remote', true)], undefined);
      const component = TestBed.runInInjectionContext(() => new CrossModelReviewPanelComponent());
      (component as unknown as { review: ReturnType<typeof signal<AggregatedReview | null>> }).review = signal(value);
      if (agentName !== undefined) {
        (component as unknown as { agentName: ReturnType<typeof signal<string>> }).agentName = signal(agentName);
      }
      return component;
    }

    it.each(['Claude', 'Codex', 'Copilot', 'Cursor', 'OpenCode'])('names the session\'s agent: %s', (name) => {
      expect(panel(name).askPrimaryLabel()).toBe(`Ask ${name} to fix these`);
    });

    it('falls back to a neutral name when none is passed', () => {
      expect(panel().askPrimaryLabel()).toBe('Ask the agent to fix these');
    });

    it('renders that label on the real button, and still offers it only when there are concerns', async () => {
      TestBed.resetTestingModule();
      await TestBed.configureTestingModule({
        providers: [{ provide: CrossModelReviewIpcService, useValue: { performAction, dismiss } }],
      }).compileComponents();
      const fixture = TestBed.createComponent(CrossModelReviewPanelComponent);
      const reviewSignal = signal<AggregatedReview | null>(review([result('claude', 'remote', true)], undefined));
      const instance = fixture.componentInstance as unknown as {
        review: typeof reviewSignal;
        agentName: ReturnType<typeof signal<string>>;
      };
      instance.review = reviewSignal;
      instance.agentName = signal('Codex');
      fixture.detectChanges();

      const labelsNow = () => [...fixture.nativeElement.querySelectorAll('button')]
        .map((button: HTMLButtonElement) => button.textContent?.trim());
      expect(labelsNow()).toContain('Ask Codex to fix these');
      expect(labelsNow()).not.toContain('Ask Claude to fix these');

      reviewSignal.set(review([result('claude', 'remote', false)], undefined));
      fixture.detectChanges();
      expect(labelsNow()).not.toContain('Ask Codex to fix these');
    });
  });

  it('keeps remote concerns authoritative while surfacing a skipped local status', async () => {
    const value = review(
      [result('codex', 'remote', true)],
      { reviewerId: 'local-model', source: 'local', status: 'skipped', reason: 'unhealthy' },
    );
    const component = TestBed.runInInjectionContext(() => new CrossModelReviewPanelComponent());
    (component as unknown as { review: ReturnType<typeof signal<AggregatedReview | null>> }).review = signal(value);

    expect(component.hasConcerns()).toBe(true);
    expect(component.headerTitle()).toContain('1 concern');
    expect(component.localStatusText()).toContain('Local reviewer: skipped');
    expect(component.localStatusText()).toContain('unhealthy');

    await component.onAction('start-debate');
    expect(performAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'start-debate' }));
  });
});
