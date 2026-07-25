import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import type { MobileQueuedMessageDto } from '../../core/models';

/** Longest queued preview shown before ellipsis. */
const PREVIEW_CHARS = 90;

/**
 * Messages the host is holding because the session was mid-turn when they were
 * sent. Mirrors the desktop composer queue: preview, cancel-restores-to-input,
 * and a visible failure state for an item that could not be delivered.
 */
@Component({
  standalone: true,
  selector: 'app-composer-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileIconComponent],
  template: `
    <div class="queue" role="list" aria-label="Queued messages">
      <div class="queue-head">
        <span class="queue-count">{{ messages().length }}</span>
        {{ messages().length === 1 ? 'message queued' : 'messages queued' }}
      </div>
      @for (item of messages(); track item.id) {
        <div class="queue-row" role="listitem" [class.failed]="!!item.error">
          <span class="queue-text">{{ preview(item.message) }}</span>
          @if (item.hasAttachments) {
            <app-mobile-icon class="queue-flag" name="attachment" />
          }
          <button
            type="button"
            class="queue-cancel"
            (click)="cancelMessage.emit(item)"
            aria-label="Cancel queued message"
          >
            <app-mobile-icon name="close" />
          </button>
          @if (item.error) {
            <p class="queue-error">Couldn't send: {{ item.error }}</p>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .queue {
        border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
        padding: 6px 12px 2px;
      }
      .queue-head {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-bottom: 4px;
      }
      .queue-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--accent-action);
        color: #fff;
        font-size: 11px;
        letter-spacing: 0;
      }
      .queue-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 5px 0;
        color: var(--text-secondary);
        font-size: 13px;
      }
      .queue-row.failed .queue-text {
        color: var(--accent-error);
      }
      .queue-text {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .queue-flag {
        flex: none;
        font-size: 14px;
        color: var(--text-secondary);
      }
      .queue-cancel {
        flex: none;
        background: none;
        border: none;
        padding: 4px;
        margin: 0;
        color: var(--text-secondary);
        font-size: 16px;
        line-height: 1;
      }
      .queue-cancel:active {
        color: var(--text-primary);
      }
      .queue-error {
        flex: 1 0 100%;
        margin: 0;
        color: var(--accent-error);
        font-size: 12px;
      }
    `,
  ],
})
export class ComposerQueueComponent {
  readonly messages = input.required<MobileQueuedMessageDto[]>();
  /** Cancel one queued message; the parent restores its text to the composer. */
  readonly cancelMessage = output<MobileQueuedMessageDto>();

  protected preview(message: string): string {
    const flat = message.replace(/\s+/g, ' ').trim();
    return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
  }
}
