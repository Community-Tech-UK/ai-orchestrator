import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { SideChatParentRef } from '../../../../shared/types/side-chat.types';
import { SideChatStore } from '../../core/state/side-chat.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { sideChatRowBadge } from '../side-chat/side-chat-badge';

/** The same archived-session entrypoint in the project rail and History sidebar. */
@Component({
  selector: 'app-history-side-chat-badge',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (badge(); as rowBadge) {
      <button
        type="button"
        class="side-chat-badge"
        [attr.data-kind]="rowBadge.kind"
        [appTooltip]="rowBadge.label + ', open sidechats'"
        [attr.aria-label]="rowBadge.label + ', open sidechats'"
        (click)="open($event)"
        (keydown.enter)="$event.stopPropagation()"
        (keydown.space)="$event.stopPropagation()"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>{{ rowBadge.label }}</span>
      </button>
    }
  `,
  styles: [`
    :host { display: inline-flex; flex-shrink: 0; }
    .side-chat-badge {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 0 5px;
      height: 16px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      cursor: pointer;
    }
    .side-chat-badge:focus-visible { outline: 2px solid var(--secondary-color); outline-offset: 1px; }
    .side-chat-badge[data-kind='unread'] { color: var(--secondary-color); border-color: var(--secondary-color); }
    .side-chat-badge[data-kind='needs-attention'] { color: var(--warning-color); border-color: var(--warning-color); }
    .side-chat-badge[data-kind='running'] svg { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) { .side-chat-badge[data-kind='running'] svg { animation: none; } }
  `],
})
export class HistorySideChatBadgeComponent {
  private readonly store = inject(SideChatStore);
  readonly entry = input.required<ConversationHistoryEntry>();
  readonly opened = output<void>();

  // History's generic thread resolver falls back to provider-native/session
  // ids for older entries. Those are never sidechat ownership identities.
  private readonly parent = computed<SideChatParentRef | null>(() => {
    const entry = this.entry();
    return entry.historyThreadId ? {
      kind: 'session', historyThreadId: entry.historyThreadId,
      originNodeId: entry.executionLocation?.type === 'remote' ? entry.executionLocation.nodeId : null,
    } : null;
  });

  readonly badge = computed(() => {
    const parent = this.parent();
    return sideChatRowBadge(parent ? this.store.attentionFor(parent) : null);
  });

  open(event: Event): void {
    event.stopPropagation();
    const parent = this.parent();
    if (!parent) return;
    // The panel loads the parent's selector for quiet conversations. Attention
    // requests carry their exact target and do not wait on a separate fetch.
    this.store.requestOpen(parent, this.store.attentionFor(parent)?.targetChatId ?? null);
    this.opened.emit();
  }
}
