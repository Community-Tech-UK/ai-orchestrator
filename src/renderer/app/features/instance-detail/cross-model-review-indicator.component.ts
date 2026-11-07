/**
 * Cross-Model Review Indicator Component
 *
 * A small status badge displayed in the instance header that shows the current
 * state of the cross-model review for a given instance.
 */

import { Component, input, output, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { countReviewResultsWithConcerns } from '../../../../shared/utils/cross-model-review-concerns';

@Component({
  selector: 'app-cross-model-review-indicator',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hasVisibleState()) {
      <button
        type="button"
        class="review-indicator"
        [class.reviewing]="isPending()"
        [class.verified]="!isPending() && isVerified()"
        [class.concerns]="!isPending() && hasConcerns()"
        [class.advisory]="!isPending() && hasLocalAdvisory() && !hasConcerns() && !isVerified()"
        [class.failed]="!isPending() && hasLocalFailure() && !hasConcerns() && !isVerified()"
        [class.skipped]="!isPending() && !hasFinishedReview() && (isSkipped() || limitReached())"
        [appTooltip]="tooltip()"
        (click)="indicatorClicked.emit()"
      >
        @if (isPending()) {
          <span class="spinner">&#x21bb;</span> Second opinion: checking…
        } @else if (isVerified()) {
          Second opinion: &#x2713;
        } @else if (hasConcerns()) {
          Second opinion: {{ concernCount() }} concern{{ concernCount() > 1 ? 's' : '' }}
        } @else if (hasLocalAdvisory()) {
          Second opinion: local model only
        } @else if (hasLocalFailure()) {
          Second opinion: failed
        } @else if (limitReached()) {
          Second opinion: limit reached
        } @else if (isSkipped()) {
          Second opinion: skipped
        }
      </button>
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

  limitReached = computed(() => this.reviewService.status()?.dailyUsage?.limitReached ?? false);
  hasFinishedReview = computed(() => this.review() != null);

  hasVisibleState = computed(() =>
    this.isPending() || this.isSkipped() || this.limitReached() || this.review() != null
  );

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return countReviewResultsWithConcerns(this.remoteReviews());
  });

  /** The measured count shows in every state except the limit one, which already states it. */
  tooltip = computed(() => {
    const usage = this.reviewService.status()?.dailyUsage;
    return this.tooltipDetails() + (usage && !this.limitReached() ? ` Second opinions today: ${usage.used} of ${usage.limit}.` : '');
  });

  private readonly tooltipDetails = computed(() => {
    const usage = this.reviewService.status()?.dailyUsage;
    const limit = this.limitReached() && usage
      ? `${copyFor('secondOpinion.limitReached')} ${usage.used} of ${usage.limit} used today. Resets at midnight.`
      : '';
    if (this.isPending()) return `${copyFor('secondOpinion.checking')}${limit ? ` ${limit}` : ''}`;
    const r = this.review();
    if (!r) return limit || (this.isSkipped() ? copyFor('secondOpinion.skipped') : 'No review available');
    const turn = r.turnSeq === undefined ? ' Latest completed turn.' : ` Reviewed turn ${r.turnSeq}.`;
    const local = r.localReviewer;
    const localSuffix = local
      ? ` Local reviewer ${local.status}${local.reason ? `: ${local.reason}` : ''}.`
      : this.localReviews().length > 0 ? ' Local reviewer output is advisory.' : '';
    const suffix = `${turn}${limit ? ` ${limit}` : ''}`;
    if (this.hasConcerns()) return `${copyFor('secondOpinion.concerns')}${localSuffix}${suffix}`;
    if (this.isVerified()) return `${copyFor('secondOpinion.verified')}${localSuffix}${suffix}`;
    if (local?.status === 'failed') return `${copyFor('secondOpinion.failed')}${localSuffix} No remote reviewer completed.${suffix}`;
    if (local?.status === 'skipped') return `${copyFor('secondOpinion.skipped')}${localSuffix}${suffix}`;
    return `${copyFor('secondOpinion.localOnly')}${localSuffix}${suffix}`;
  });
}
