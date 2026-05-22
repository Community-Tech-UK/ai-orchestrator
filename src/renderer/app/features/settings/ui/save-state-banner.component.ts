/**
 * Save State Banner - shows explicit Saved / Saving / Unsaved / Error states
 * for draft-style settings flows, with Apply and Reset actions when dirty.
 *
 * Part of the settings UI kit (copilot_todo.md items 4 & 5): standardizes the
 * draft/apply/save affordance so it is consistent across settings sections.
 */

import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';

export type SaveState = 'saved' | 'saving' | 'dirty' | 'restart' | 'error';

@Component({
  selector: 'app-save-state-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="save-banner" [attr.data-state]="state">
      <span class="save-status">
        @switch (state) {
          @case ('saving') {
            <span class="spinner" aria-hidden="true"></span>
            <span>Saving changes…</span>
          }
          @case ('dirty') {
            <span class="dot" aria-hidden="true"></span>
            <span>Unsaved changes</span>
          }
          @case ('restart') {
            <span class="dot" aria-hidden="true"></span>
            <span>Needs restart</span>
          }
          @case ('error') {
            <span class="dot" aria-hidden="true"></span>
            <span>{{ errorText || 'Could not save changes' }}</span>
          }
          @default {
            <svg class="check" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span>All changes saved</span>
          }
        }
      </span>

      @if (state === 'dirty' || state === 'restart' || state === 'error') {
        <span class="save-actions">
          <button type="button" class="banner-btn ghost" (click)="discard.emit()">
            Reset
          </button>
          <button type="button" class="banner-btn primary" (click)="apply.emit()">
            Apply changes
          </button>
        </span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .save-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        padding: var(--spacing-sm) var(--spacing-lg);
        background: var(--surface-sunken-bg);
        border-top: 1px solid var(--border-subtle);
        font-size: var(--text-sm);
        min-height: 44px;
      }

      .save-status {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-sm);
        color: var(--text-secondary);
        font-weight: 500;
      }

      .save-banner[data-state='saved'] .save-status {
        color: var(--pill-ok-fg);
      }

      .save-banner[data-state='dirty'] .save-status,
      .save-banner[data-state='restart'] .save-status,
      .save-banner[data-state='error'] .save-status {
        color: var(--text-primary);
      }

      .check {
        color: var(--pill-ok-fg);
      }

      .dot {
        width: 7px;
        height: 7px;
        border-radius: var(--radius-full);
        flex-shrink: 0;
      }

      .save-banner[data-state='dirty'] .dot {
        background: var(--warning-color);
      }

      .save-banner[data-state='restart'] .dot {
        background: var(--info-color);
      }

      .save-banner[data-state='error'] .dot {
        background: var(--error-color);
      }

      .spinner {
        width: 13px;
        height: 13px;
        border-radius: var(--radius-full);
        border: 2px solid var(--border-strong);
        border-top-color: var(--primary-color);
        animation: spin 0.7s linear infinite;
        flex-shrink: 0;
      }

      .save-actions {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .banner-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);
        border: 1px solid transparent;
      }

      .banner-btn.ghost {
        background: transparent;
        color: var(--text-secondary);
        border-color: var(--border-color);
      }

      .banner-btn.ghost:hover {
        background: var(--glass-medium);
        color: var(--text-primary);
      }

      .banner-btn.primary {
        background: var(--primary-color);
        color: var(--button-on-primary);
      }

      .banner-btn.primary:hover {
        background: var(--primary-hover);
      }

      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 2s;
        }
      }
    `,
  ],
})
export class SaveStateBannerComponent {
  /** Current persistence state of the section. */
  @Input() state: SaveState = 'saved';
  /** Error detail shown when `state` is `error`. */
  @Input() errorText: string | null = null;
  /** Emitted when the user commits the pending draft. */
  @Output() readonly apply = new EventEmitter<void>();
  /** Emitted when the user discards the pending draft. */
  @Output() readonly discard = new EventEmitter<void>();
}
