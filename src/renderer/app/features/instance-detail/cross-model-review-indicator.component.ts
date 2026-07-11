/**
 * Cross-Model Review Indicator Component
 *
 * A small status badge displayed in the instance header that shows the current
 * state of the cross-model review for a given instance.
 */

import { Component, input, output, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { countReviewResultsWithConcerns } from '../../../../shared/utils/cross-model-review-concerns';

@Component({
  selector: 'app-cross-model-review-indicator',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (enabled() && hasVisibleState()) {
      <span
        class="review-indicator"
        [class.reviewing]="isPending()"
        [class.verified]="isVerified()"
        [class.concerns]="hasConcerns()"
        [class.advisory]="hasLocalAdvisory() && !hasConcerns() && !isVerified()"
        [class.failed]="hasLocalFailure() && !hasConcerns() && !isVerified()"
        [class.skipped]="isSkipped()"
        [title]="tooltip()"
        role="button"
        tabindex="0"
        (click)="indicatorClicked.emit()"
        (keydown.enter)="indicatorClicked.emit()"
        (keydown.space)="indicatorClicked.emit()"
      >
        @if (isPending()) {
          <span class="spinner">&#x21bb;</span> Reviewing...
        } @else if (isVerified()) {
          &#x2713; Verified{{ hasLocalAdvisory() ? ' + local advisory' : '' }}
        } @else if (hasConcerns()) {
          &#x26A0; {{ concernCount() }} concern{{ concernCount() > 1 ? 's' : '' }}
        } @else if (hasLocalAdvisory()) {
          &#x2691; Local advisory
        } @else if (hasLocalFailure()) {
          &#x26A0; Review failed
        } @else if (isSkipped()) {
          &#x2014;
        }
      </span>
    }
  `,
  styles: [`
    .review-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-family: var(--font-mono);
      font-weight: 600;
      letter-spacing: 0.04em;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      cursor: pointer;
      user-select: none;
      transition: opacity var(--transition-fast);

      &:hover {
        opacity: 0.8;
      }
    }

    .reviewing {
      color: var(--text-secondary);
      background: rgba(255, 255, 255, 0.025);
    }

    .verified {
      color: #51cf66;
      background: rgba(81, 207, 102, 0.1);
      border-color: rgba(81, 207, 102, 0.2);
    }

    .concerns {
      color: #ffc078;
      background: rgba(255, 192, 120, 0.1);
      border-color: rgba(255, 192, 120, 0.2);
    }

    .advisory {
      color: #74c0fc;
      background: rgba(116, 192, 252, 0.1);
      border-color: rgba(116, 192, 252, 0.2);
    }

    .failed {
      color: #ffc078;
      background: rgba(255, 192, 120, 0.1);
      border-color: rgba(255, 192, 120, 0.2);
    }

    .skipped {
      color: var(--text-muted);
      background: transparent;
      border-color: transparent;
    }

    .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `],
})
export class CrossModelReviewIndicatorComponent {
  instanceId = input.required<string>();
  indicatorClicked = output<void>();

  private reviewService = inject(CrossModelReviewIpcService);

  private review = computed(() => this.reviewService.getReviewForInstance(this.instanceId()));
  private remoteReviews = computed(() =>
    this.review()?.reviews.filter((result) => result.source !== 'local') ?? []
  );
  private localReviews = computed(() =>
    this.review()?.reviews.filter((result) => result.source === 'local') ?? []
  );

  enabled = computed(() => {
    const s = this.reviewService.status();
    return s?.enabled ?? false;
  });

  isPending = computed(() => this.reviewService.pendingInstances().has(this.instanceId()));
  isSkipped = computed(() => this.reviewService.skippedInstances().has(this.instanceId()));

  isVerified = computed(() => {
    return this.remoteReviews().length > 0 && !this.hasConcerns();
  });

  hasConcerns = computed(() => {
    return countReviewResultsWithConcerns(this.remoteReviews()) > 0;
  });

  hasLocalAdvisory = computed(() =>
    this.localReviews().length > 0 || this.review()?.localReviewer?.status === 'used'
  );

  hasLocalFailure = computed(() => this.review()?.localReviewer?.status === 'failed');

  hasVisibleState = computed(() =>
    this.isPending() || this.isSkipped() || this.review() != null
  );

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return countReviewResultsWithConcerns(this.remoteReviews());
  });

  tooltip = computed(() => {
    if (this.isPending()) return 'Cross-model review in progress...';
    if (this.isSkipped()) return 'Cross-model review skipped because no secondary reviewers were available';
    const r = this.review();
    if (!r) return 'No review available';
    const local = r.localReviewer;
    const localSuffix = local
      ? ` Local reviewer ${local.status}${local.reason ? `: ${local.reason}` : ''}.`
      : this.localReviews().length > 0 ? ' Local reviewer output is advisory.' : '';
    if (this.hasConcerns()) return `Remote reviewers flagged concerns \u2014 click to view.${localSuffix}`;
    if (this.isVerified()) return `Remote reviewers approved this output.${localSuffix}`;
    if (local?.status === 'failed') return `Local reviewer failed: ${local.reason ?? 'unknown failure'}. No remote reviewer completed.`;
    if (local?.status === 'skipped') return `Local reviewer skipped: ${local.reason ?? 'unavailable'}. No remote reviewer completed.`;
    return 'Local review completed as advisory; no remote reviewer completed.';
  });
}
