import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { OVERALL_OPTIONS } from './doc-review.types';
import type { DocReviewItemState, DocReviewOverall } from './doc-review.types';

/**
 * Angular-owned chrome for a review: overall verdict buttons, a general comment box, and
 * a mirror of the per-item decisions the sandboxed artifact reported. Submit is enabled
 * only once an overall verdict is chosen. Purely presentational — the page owns state.
 */
@Component({
  selector: 'app-doc-review-decision-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar">
      <div class="items">
        @for (item of items(); track item.info.id) {
          <div class="item">
            <span class="item-title">
              @if (item.info.decisionId) {
                <span class="num">{{ item.info.decisionId }}</span>
              }
              {{ item.info.title }}
            </span>
            <span
              class="pill"
              [class.pill-ok]="item.decision === 'approve'"
              [class.pill-error]="item.decision === 'reject'"
              [class.pill-neutral]="!item.decision"
            >{{ item.decision ? (item.decision === 'approve' ? 'Approved' : 'Rejected') : 'No verdict' }}</span>
            @if (item.comment.trim()) {
              <span class="comment">“{{ item.comment.trim() }}”</span>
            }
          </div>
        } @empty {
          <p class="empty">Toggle Approve/Reject and add comments per section in the document above.</p>
        }
      </div>

      <div class="controls">
        <div class="overall" role="group" aria-label="Overall verdict">
          @for (option of overallOptions; track option.value) {
            <button
              type="button"
              class="verdict-btn"
              [class.active]="overall() === option.value"
              [attr.aria-pressed]="overall() === option.value"
              (click)="overallChange.emit(option.value)"
            >{{ option.label }}</button>
          }
        </div>
        <input
          class="general"
          type="text"
          placeholder="General feedback (optional)"
          [value]="general()"
          (input)="generalChange.emit($any($event.target).value)"
        />
        <button
          type="button"
          class="submit"
          [disabled]="!canSubmit() || busy()"
          (click)="submitted.emit()"
        >{{ busy() ? 'Sending…' : 'Submit decision' }}</button>
      </div>
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .bar {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--card-bg);
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .items { display: flex; flex-direction: column; gap: 6px; max-height: 160px; overflow: auto; }
      .item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
      .item-title { color: var(--text-primary); font-weight: 500; }
      .num {
        display: inline-flex; align-items: center; justify-content: center;
        min-width: 18px; height: 18px; padding: 0 4px; margin-right: 4px;
        border-radius: 999px; background: var(--pill-accent-bg); color: var(--pill-accent-fg);
        font-size: 11px; font-weight: 700;
      }
      .comment { color: var(--text-muted); font-style: italic; }
      .empty { color: var(--text-muted); font-size: 13px; margin: 0; }
      .pill {
        font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
        border: 1px solid transparent;
      }
      .pill-ok { background: var(--pill-ok-bg); color: var(--pill-ok-fg); border-color: var(--pill-ok-border); }
      .pill-error { background: var(--pill-error-bg); color: var(--pill-error-fg); border-color: var(--pill-error-border); }
      .pill-neutral { background: var(--pill-neutral-bg); color: var(--text-muted); }
      .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
      .overall { display: inline-flex; gap: 6px; }
      .verdict-btn, .submit {
        appearance: none; border: 1px solid var(--border-color); border-radius: 8px;
        background: var(--bg-secondary); color: var(--text-primary);
        padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
        transition: background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
      }
      .verdict-btn:hover, .submit:hover:not(:disabled) { border-color: var(--primary-color); }
      .verdict-btn:active, .submit:active:not(:disabled) { transform: scale(0.96); }
      .verdict-btn.active { background: var(--primary-color); color: var(--button-on-primary); border-color: var(--primary-color); }
      .general {
        flex: 1 1 240px; min-width: 200px;
        border: 1px solid var(--border-color); border-radius: 8px;
        background: var(--bg-secondary); color: var(--text-primary);
        padding: 8px 10px; font: inherit; font-size: 13px;
      }
      .submit { margin-left: auto; background: var(--primary-color); color: var(--button-on-primary); border-color: var(--primary-color); }
      .submit:disabled { opacity: 0.5; cursor: not-allowed; }
      .verdict-btn:focus-visible, .general:focus, .submit:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { .verdict-btn, .submit { transition: none; } }
    `,
  ],
})
export class DocReviewDecisionBarComponent {
  readonly items = input.required<DocReviewItemState[]>();
  readonly overall = input<DocReviewOverall | null>(null);
  readonly general = input('');
  readonly busy = input(false);

  readonly overallChange = output<DocReviewOverall>();
  readonly generalChange = output<string>();
  readonly submitted = output<void>();

  readonly overallOptions = OVERALL_OPTIONS;
  readonly canSubmit = computed(() => this.overall() !== null);
}
