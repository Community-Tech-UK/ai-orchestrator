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
  styleUrl: './save-state-banner.component.scss',
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
