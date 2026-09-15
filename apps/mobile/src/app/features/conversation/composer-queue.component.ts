import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MobileQueuedMessageDto } from '../../core/models';

/** Ordered queued drafts, with deliberate recovery and removal actions. */
@Component({
  standalone: true,
  selector: 'app-composer-queue',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="queue" aria-label="Queued messages">
      <button type="button" class="queue-head" (click)="expanded.set(!expanded())"
        [attr.aria-expanded]="expanded()">
        <span class="queue-count">{{ messages().length }}</span>
        {{ messages().length === 1 ? 'message queued' : 'messages queued' }}
        <span class="queue-disclosure">{{ expanded() ? 'Hide' : 'Show' }}</span>
      </button>
      @if (blocked()) {
        <p class="queue-error" role="status">Queue blocked. Return the first message to your draft or remove it so later messages can be sent in order.</p>
      }
      @if (expanded()) {
        <ol class="queue-list">
          @for (item of messages(); track item.id; let index = $index) {
            <li class="queue-row" [class.failed]="!!item.error">
              <p class="queue-position">Message {{ index + 1 }} · {{ item.error ? 'Failed' : blocked() && index > 0 ? 'Waiting for message 1' : 'Queued' }}</p>
              <p class="queue-text">{{ item.message || 'Attachment message' }}</p>
              @if (item.hasAttachments) {
                <p class="queue-flag">Attachments included</p>
              }
              @if (item.error) {
                <p class="queue-error">Couldn't send: {{ item.error }}</p>
              }
              <div class="queue-actions" [attr.aria-busy]="pendingId() === item.id">
                <button type="button" (click)="recover(item)" [disabled]="pendingId() !== null"
                  [attr.aria-label]="'Return to draft: message ' + (index + 1)">Return to draft</button>
                <button type="button" (click)="remove(item)" [disabled]="pendingId() !== null"
                  [attr.aria-label]="'Remove message ' + (index + 1)">Remove</button>
              </div>
              @if (pendingId() === item.id) {
                <p class="queue-flag" role="status">Updating queue…</p>
              }
            </li>
          }
        </ol>
      }
    </section>
  `,
  styles: [`
    :host { display: block; min-height: 0; flex-shrink: 0; }
    .queue { border-top: 1px solid var(--separator); padding: 0 12px; }
    .queue-head {
      display: flex; align-items: center; gap: 8px; min-height: 44px; width: 100%;
      background: none; border: none; color: var(--text-secondary); text-align: left;
      padding: 4px 0; font: inherit; font-size: 13px;
    }
    .queue-count {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 24px; min-height: 24px; padding: 0 6px; border-radius: 12px;
      background: var(--accent-action); color: #000; font-weight: 600;
    }
    .queue-disclosure { margin-left: auto; color: var(--text); }
    .queue-list { list-style: none; margin: 0; padding: 0; max-height: min(36dvh, 360px); overflow-y: auto; }
    .queue-row { border-top: 1px solid var(--separator); padding: 10px 0; }
    .queue-position, .queue-flag { color: var(--text-secondary); font-size: 12px; margin: 0 0 6px; }
    .queue-text { color: var(--text); font-size: 14px; line-height: 1.45; margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .queue-error { color: var(--accent-error); font-size: 13px; line-height: 1.4; margin: 0 0 8px; overflow-wrap: anywhere; }
    .failed .queue-position { color: var(--accent-error); }
    .queue-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .queue-actions button {
      min-width: 44px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--separator);
      border-radius: 8px; background: none; color: var(--text); font: inherit; font-size: 13px;
    }
    button:disabled { opacity: 0.5; }
    button:focus-visible { outline: 2px solid var(--accent-action); outline-offset: -2px; }
  `],
})
export class ComposerQueueComponent {
  readonly messages = input.required<MobileQueuedMessageDto[]>();
  readonly pendingId = input<string | null>(null);
  /** Cancel one queued message and restore its complete draft in the parent. */
  readonly cancelMessage = output<MobileQueuedMessageDto>();
  /** Cancel one queued message and discard its content in the parent. */
  readonly removeMessage = output<MobileQueuedMessageDto>();
  protected readonly expanded = signal(false);
  protected readonly blocked = computed(() => Boolean(this.messages()[0]?.error));

  protected recover(item: MobileQueuedMessageDto): void {
    if (this.pendingId() === null) this.cancelMessage.emit(item);
  }

  protected remove(item: MobileQueuedMessageDto): void {
    if (this.pendingId() === null) this.removeMessage.emit(item);
  }
}
