import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  effect,
} from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import type {
  AggregatedReview,
  ReviewResult,
  ReviewActionType,
} from '../../../../shared/types/cross-model-review.types';
import {
  countReviewResultsWithConcerns,
  getReviewResultConcernItems,
} from '../../../../shared/utils/cross-model-review-concerns';

@Component({
  selector: 'app-cross-model-review-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (review()) {
      <div class="review-panel">
        <button
          type="button"
          class="review-panel-header"
          [attr.aria-expanded]="expanded()"
          (click)="togglePanel()"
        >
          <span class="review-icon">
            @if (hasConcerns()) {
              &#x26A0;
            } @else {
              &#x2713;
            }
          </span>
          <span class="review-title">
            @if (hasConcerns()) {
              Cross-Model Review: {{ concernCount() }} concern{{ concernCount() !== 1 ? 's' : '' }} found
            } @else {
              Cross-Model Review: verified
            }
          </span>
          <span class="review-toggle" aria-hidden="true">
            {{ expanded() ? '&#x25B2;' : '&#x25BC;' }}
          </span>
        </button>

        @if (expanded()) {
          <div class="review-panel-body">
            <div class="review-actions">
              <button class="btn-review-action" type="button" (click)="onAction('dismiss')">Dismiss</button>
              @if (hasConcerns()) {
                <button class="btn-review-action btn-primary" type="button" (click)="onAction('ask-primary')">
                  Ask Claude to Address
                </button>
              }
              <button class="btn-review-action" type="button" (click)="toggleAllReviewers()">
                {{ allReviewersExpanded() ? 'Collapse' : 'Expand' }} Items
              </button>
              <button class="btn-review-action" type="button" (click)="showingFull.set(!showingFull())">
                {{ showingFull() ? 'Hide' : 'Full' }} Review
              </button>
              @if (hasConcerns()) {
                <button class="btn-review-action" type="button" (click)="onAction('start-debate')">
                  Start Debate
                </button>
              }
            </div>

            @for (result of review()!.reviews; track result.reviewerId) {
              <div class="reviewer-section">
                <button
                  type="button"
                  class="reviewer-header"
                  [attr.aria-expanded]="isReviewerExpanded(result)"
                  (click)="toggleReviewer(result)"
                >
                  <span class="reviewer-label">
                    <span class="reviewer-name">
                      {{ result.reviewerId }} ({{ result.reviewType }} review)
                    </span>
                    <span class="reviewer-meta">
                      {{ issueCount(result) }} issue{{ issueCount(result) !== 1 ? 's' : '' }}
                    </span>
                  </span>
                  <span class="reviewer-summary-inline">{{ result.summary }}</span>
                  <span class="reviewer-toggle" aria-hidden="true">
                    {{ isReviewerExpanded(result) ? '&#x25B2;' : '&#x25BC;' }}
                  </span>
                </button>

                @if (isReviewerExpanded(result)) {
                  <div class="reviewer-details">
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
              </div>
            }

            @if (review()!.reviews.length === 0) {
              <div class="empty-review-note">No reviewer results available.</div>
            }

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
      width: 100%;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border: 0;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      text-align: left;
    }
    .review-icon { color: #ffc078; }
    .review-title { flex: 1; font-weight: 500; }
    .review-toggle { font-size: 10px; color: var(--text-secondary); }
    .review-panel-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 12px 12px;
    }
    .reviewer-section {
      border-left: 3px solid var(--border-accent, #4a90e2);
      background: var(--bg-hover, rgba(255,255,255,0.03));
    }
    .reviewer-header {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 8px;
      padding: 8px;
      border: 0;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .reviewer-header:hover { background: rgba(255,255,255,0.04); }
    .reviewer-label {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-shrink: 0;
    }
    .reviewer-name { font-size: 12px; font-weight: 600; }
    .reviewer-meta {
      color: var(--text-secondary);
      font-size: 10px;
      font-family: var(--font-mono);
    }
    .reviewer-summary-inline {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      color: var(--text-tertiary);
      font-size: 11px;
      font-style: italic;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .reviewer-toggle {
      flex-shrink: 0;
      color: var(--text-secondary);
      font-size: 10px;
    }
    .reviewer-details { padding: 0 8px 8px; }
    .scores-grid { display: flex; gap: 12px; font-size: 11px; margin-bottom: 4px; }
    .score-item { color: var(--text-secondary); }
    .score-low { color: #ff6b6b; font-weight: 600; }
    .issue-item { font-size: 12px; color: #ffc078; padding: 2px 0 2px 8px; }
    .reviewer-summary { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; font-style: italic; }
    .review-actions { display: flex; gap: 8px; flex-wrap: wrap; }
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
    .empty-review-note {
      color: var(--text-tertiary);
      font-size: 11px;
      padding: 8px;
    }
    .full-review-json {
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
  expandedReviewerIds = signal(new Set<string>());

  private lastReviewId: string | null = null;
  private reviewResetEffect = effect(() => {
    const reviewId = this.review()?.id ?? null;
    if (reviewId === this.lastReviewId) return;
    this.lastReviewId = reviewId;
    this.expandedReviewerIds.set(new Set<string>());
    this.showingFull.set(false);
  });

  private reviewService = inject(CrossModelReviewIpcService);

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return countReviewResultsWithConcerns(r.reviews);
  });

  hasConcerns = computed(() => {
    const r = this.review();
    return r != null && (r.hasDisagreement || this.concernCount() > 0);
  });

  allReviewersExpanded = computed(() => {
    const r = this.review();
    if (!r || r.reviews.length === 0) return false;
    const expanded = this.expandedReviewerIds();
    return r.reviews.every(result => expanded.has(this.reviewerKey(result)));
  });

  fullReviewJson = computed(() => {
    const r = this.review();
    if (!r) return '';
    return JSON.stringify(r.reviews, null, 2);
  });

  togglePanel(): void {
    this.expanded.update(value => !value);
  }

  reviewerKey(result: ReviewResult): string {
    return result.reviewerId;
  }

  isReviewerExpanded(result: ReviewResult): boolean {
    return this.expandedReviewerIds().has(this.reviewerKey(result));
  }

  toggleReviewer(result: ReviewResult): void {
    const key = this.reviewerKey(result);
    const next = new Set(this.expandedReviewerIds());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.expandedReviewerIds.set(next);
  }

  toggleAllReviewers(): void {
    const r = this.review();
    if (!r) return;
    if (this.allReviewersExpanded()) {
      this.expandedReviewerIds.set(new Set<string>());
      return;
    }
    this.expandedReviewerIds.set(new Set(r.reviews.map(result => this.reviewerKey(result))));
  }

  allIssues(result: ReviewResult): string[] {
    return getReviewResultConcernItems(result);
  }

  issueCount(result: ReviewResult): number {
    return this.allIssues(result).length;
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
