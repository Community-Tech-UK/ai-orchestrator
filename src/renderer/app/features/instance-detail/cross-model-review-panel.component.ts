import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
  computed,
  inject,
} from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import type {
  AggregatedReview,
  ReviewResult,
  ReviewActionType,
} from '../../../../shared/types/cross-model-review.types';

@Component({
  selector: 'app-cross-model-review-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (review()) {
      <div class="review-panel">
        <div class="review-panel-header" role="button" tabindex="0" (click)="expanded.set(!expanded())" (keydown.enter)="expanded.set(!expanded())" (keydown.space)="expanded.set(!expanded())"  >
          <span class="review-icon">&#x26A0;</span>
          <span class="review-title">
            Cross-Model Review: {{ concernCount() }} concern{{ concernCount() !== 1 ? 's' : '' }} found
          </span>
          <span class="review-toggle">{{ expanded() ? '&#x25B2;' : '&#x25BC;' }}</span>
        </div>

        @if (expanded()) {
          <div class="review-panel-body">
            @for (result of review()!.reviews; track result.reviewerId) {
              <div class="reviewer-section">
                <h4 class="reviewer-name">
                  {{ result.reviewerId }} ({{ result.reviewType }} review)
                </h4>
                <div class="scores-grid">
                  <span class="score-item" [class.score-low]="result.scores.correctness.score <= 2">
                    Correctness: {{ result.scores.correctness.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.completeness.score <= 2">
                    Completeness: {{ result.scores.completeness.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.security.score <= 2">
                    Security: {{ result.scores.security.score }}/4
                  </span>
                  <span class="score-item" [class.score-low]="result.scores.consistency.score <= 2">
                    Consistency: {{ result.scores.consistency.score }}/4
                  </span>
                </div>
                @for (issue of allIssues(result); track issue) {
                  <div class="issue-item">&rarr; {{ issue }}</div>
                }
                <div class="reviewer-summary">{{ result.summary }}</div>
              </div>
            }

            <div class="review-actions">
              <button class="btn-review-action" (click)="onAction('dismiss')">Dismiss</button>
              <button class="btn-review-action btn-primary" (click)="onAction('ask-primary')">
                Ask Claude to Address
              </button>
              <button class="btn-review-action" (click)="showingFull.set(!showingFull())">
                {{ showingFull() ? 'Hide' : 'Full' }} Review
              </button>
              <button class="btn-review-action" (click)="onAction('start-debate')">
                Start Debate
              </button>
            </div>

            @if (showingFull()) {
              <pre class="full-review-json">{{ fullReviewJson() }}</pre>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .review-panel {
      border: 1px solid var(--border-warning, #ffc078);
      border-radius: 4px;
      margin: 8px 0;
      background: var(--bg-surface, #1a1a2e);
    }
    .review-panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
    }
    .review-icon { color: #ffc078; }
    .review-title { flex: 1; font-weight: 500; }
    .review-toggle { font-size: 10px; color: var(--text-secondary); }
    .review-panel-body { padding: 0 12px 12px; }
    .reviewer-section {
      padding: 8px;
      margin-bottom: 8px;
      border-left: 3px solid var(--border-accent, #4a90e2);
      background: var(--bg-hover, rgba(255,255,255,0.03));
    }
    .reviewer-name { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
    .scores-grid { display: flex; gap: 12px; font-size: 11px; margin-bottom: 4px; }
    .score-item { color: var(--text-secondary); }
    .score-low { color: #ff6b6b; font-weight: 600; }
    .issue-item { font-size: 12px; color: #ffc078; padding: 2px 0 2px 8px; }
    .reviewer-summary { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; font-style: italic; }
    .review-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .btn-review-action {
      padding: 4px 10px;
      font-size: 11px;
      border: 1px solid var(--border-secondary);
      border-radius: 3px;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
    }
    .btn-review-action:hover { background: var(--bg-hover); }
    .btn-primary {
      background: var(--accent-primary, #4a90e2);
      border-color: var(--accent-primary, #4a90e2);
      color: white;
    }
    .full-review-json {
      margin-top: 8px;
      padding: 8px;
      background: var(--bg-code, #0d0d1a);
      border-radius: 3px;
      font-size: 10px;
      max-height: 300px;
      overflow: auto;
      white-space: pre-wrap;
    }
  `],
})
export class CrossModelReviewPanelComponent {
  review = input<AggregatedReview | null>(null);
  actionPerformed = output<{ reviewId: string; instanceId: string; action: ReviewActionType }>();

  expanded = signal(true);
  showingFull = signal(false);

  private reviewService = inject(CrossModelReviewIpcService);

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return r.reviews.filter(rev => rev.overallVerdict !== 'APPROVE').length;
  });

  fullReviewJson = computed(() => {
    const r = this.review();
    if (!r) return '';
    return JSON.stringify(r.reviews, null, 2);
  });

  allIssues(result: ReviewResult): string[] {
    return [
      ...result.scores.correctness.issues,
      ...result.scores.completeness.issues,
      ...result.scores.security.issues,
      ...result.scores.consistency.issues,
      ...(result.scores.feasibility?.issues ?? []),
    ];
  }

  async onAction(action: ReviewActionType): Promise<void> {
    const r = this.review();
    if (!r) return;

    if (action === 'dismiss') {
      await this.reviewService.dismiss({ reviewId: r.id, instanceId: r.instanceId });
    } else {
      await this.reviewService.performAction({
        reviewId: r.id,
        instanceId: r.instanceId,
        action,
      });
    }

    this.actionPerformed.emit({ reviewId: r.id, instanceId: r.instanceId, action });
  }
}
