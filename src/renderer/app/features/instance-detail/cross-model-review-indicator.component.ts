/**
 * Cross-Model Review Indicator Component
 *
 * A small status badge displayed in the instance header that shows the current
 * state of the cross-model review for a given instance.
 */

import { Component, input, output, computed, inject, ChangeDetectionStrategy } from '@angular/core';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';

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
          &#x2713; Verified
        } @else if (hasConcerns()) {
          &#x26A0; {{ concernCount() }} concern{{ concernCount() > 1 ? 's' : '' }}
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

  enabled = computed(() => {
    const s = this.reviewService.status();
    return s?.enabled ?? false;
  });

  isPending = computed(() => this.reviewService.pendingInstances().has(this.instanceId()));
  isSkipped = computed(() => this.reviewService.skippedInstances().has(this.instanceId()));

  isVerified = computed(() => {
    const r = this.review();
    return r != null && !r.hasDisagreement;
  });

  hasConcerns = computed(() => {
    const r = this.review();
    return r != null && r.hasDisagreement;
  });

  hasVisibleState = computed(() =>
    this.isPending() || this.isSkipped() || this.review() != null
  );

  concernCount = computed(() => {
    const r = this.review();
    if (!r) return 0;
    return r.reviews.filter(rev => rev.overallVerdict !== 'APPROVE').length;
  });

  tooltip = computed(() => {
    if (this.isPending()) return 'Cross-model review in progress...';
    if (this.isSkipped()) return 'Cross-model review skipped because no secondary reviewers were available';
    const r = this.review();
    if (!r) return 'No review available';
    if (r.hasDisagreement) return 'Secondary models flagged concerns \u2014 click to view';
    return 'All secondary models approved this output';
  });
}
