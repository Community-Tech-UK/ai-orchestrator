/**
 * Turn Summary Row - the quiet note under a finished turn.
 *
 * Three optional pieces, each shown only when it has something true to say:
 *  - the one-line summary ("12 s · edited 2 files +18 −3 · ran 3 commands · 1 failed");
 *  - a "Changed N files while this reply ran" button, from a real comparison of
 *    the folder before and after the turn, that asks the host to open the review panel;
 *  - a warning when an edit failed, nothing redid it, and the reply did not mention it.
 *
 * The component only presents; the numbers come from src/shared/summarise-turn.ts
 * and the baseline comparison. Raw tool text stays behind "Details" and is only
 * ever rendered as text.
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { EditFailureWarning, TurnSummary } from '../../../../shared/summarise-turn';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

@Component({
  selector: 'app-turn-summary-row',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (summary() || warning() || changedFiles() > 0) {
      <div class="turn-note">
        @if (summary()) {
          <p class="turn-line">@for (part of parts(); track $index) {@if (!$first) {<span class="sep"> · </span>}<span class="part" [class.failed]="part.failed">{{ part.text }}</span>}</p>
        }
        @if (changedFiles() > 0) {
          <p class="changed-line">
            @if (reviewable()) {
              <button
                type="button"
                class="link-btn changed-btn"
                appTooltip="Open the review panel to look over the changes"
                (click)="reviewRequested.emit()"
              >Changed {{ changedFiles() }} {{ changedFiles() === 1 ? 'file' : 'files' }} while this reply ran</button>
            } @else {
              Changed {{ changedFiles() }} {{ changedFiles() === 1 ? 'file' : 'files' }} while this reply ran
            }
          </p>
        }
        @if (warning(); as w) {
          <div class="turn-warning">
            <p class="warning-text">
              <span class="sr-only">Warning: </span>{{ w.text }}
              <button
                type="button"
                class="link-btn details-btn"
                [attr.aria-expanded]="detailsOpen()"
                (click)="detailsOpen.set(!detailsOpen())"
              >Details</button>
            </p>
            @if (detailsOpen()) {
              <ul class="warning-details">
                @for (item of w.items; track $index) {
                  <li>
                    <span class="detail-file">{{ item.path || 'File not named' }}</span>
                    <span class="detail-raw">{{ item.detail || 'The tool gave no details.' }}</span>
                  </li>
                }
              </ul>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      width: min(100%, 1100px);
      max-width: 100%;
      min-width: 0;
    }

    .turn-note {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 2px 4px 6px;
      font-size: 11px;
      line-height: 1.45;
      color: var(--text-muted);
    }

    .turn-line,
    .changed-line {
      margin: 0;
      font-variant-numeric: tabular-nums;
    }

    .sep {
      opacity: 0.6;
    }

    .failed {
      color: var(--error-color);
      font-weight: 600;
    }

    .link-btn {
      padding: 0;
      border: none;
      background: transparent;
      color: var(--primary-color);
      font: inherit;
      cursor: pointer;
      text-decoration: underline dotted;
      text-underline-offset: 2px;

      &:hover {
        color: var(--primary-hover);
      }

      &:focus-visible {
        outline: 2px solid var(--border-focus);
        outline-offset: 2px;
        border-radius: 3px;
      }
    }

    .turn-warning {
      padding: 6px 10px;
      border-left: 2px solid var(--warning-color);
      border-radius: 6px;
      background: var(--warning-bg);
      color: var(--text-secondary);
    }

    .warning-text {
      margin: 0;
    }

    .warning-details {
      margin: 6px 0 0;
      padding-left: 16px;
      color: var(--text-muted);
    }

    .detail-file {
      font-family: var(--font-mono);
    }

    .detail-raw {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `],
})
export class TurnSummaryRowComponent {
  readonly summary = input<TurnSummary | null>(null);
  readonly warning = input<EditFailureWarning | null>(null);
  /** Files that changed while the turn ran; the line shows only when this is above zero. */
  readonly changedFiles = input(0);
  /** The host can open a review panel. Without one the count is plain text, not a button that does nothing. */
  readonly reviewable = input(false);
  readonly reviewRequested = output<void>();

  protected readonly detailsOpen = signal(false);

  protected readonly parts = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    return [
      ...(summary.duration ? [{ text: summary.duration, failed: false }] : []),
      ...summary.segments.map((segment) => ({ text: segment.text, failed: segment.kind === 'failed' })),
    ];
  });
}
