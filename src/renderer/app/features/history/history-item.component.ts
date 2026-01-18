/**
 * History Item Component - Individual entry in the history list
 */

import { Component, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

@Component({
  selector: 'app-history-item',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="history-item" [class.error]="entry().status === 'error'" (click)="select.emit(entry())">
      <div class="item-header">
        <span class="display-name">{{ entry().displayName }}</span>
        <button
          class="btn-delete"
          (click)="onDelete($event)"
          title="Delete"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>

      <p class="preview">{{ entry().firstUserMessage || 'No message preview' }}</p>

      <div class="item-meta">
        <span class="date">{{ entry().endedAt | date:'MMM d, h:mm a' }}</span>
        <span class="message-count">{{ entry().messageCount }} messages</span>
        @if (entry().status === 'error') {
          <span class="status-badge error">Error</span>
        }
      </div>

      <div class="working-dir" title="{{ entry().workingDirectory }}">
        {{ shortenPath(entry().workingDirectory) }}
      </div>
    </div>
  `,
  styles: [`
    .history-item {
      padding: var(--spacing-md);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      cursor: pointer;
      transition: all var(--transition-fast);
      border: 1px solid transparent;

      &:hover {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
      }

      &.error {
        border-left: 3px solid var(--error-color);
      }
    }

    .item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-xs);
    }

    .display-name {
      font-weight: 500;
      color: var(--text-primary);
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .btn-delete {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      opacity: 0;
      transition: all var(--transition-fast);

      .history-item:hover & {
        opacity: 1;
      }

      &:hover {
        background: var(--error-color);
        color: white;
      }
    }

    .preview {
      margin: 0 0 var(--spacing-sm);
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .item-meta {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 11px;
      color: var(--text-muted);
      margin-bottom: var(--spacing-xs);
    }

    .status-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-weight: 500;

      &.error {
        background: rgba(239, 68, 68, 0.1);
        color: var(--error-color);
      }
    }

    .working-dir {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
})
export class HistoryItemComponent {
  entry = input.required<ConversationHistoryEntry>();

  select = output<ConversationHistoryEntry>();
  delete = output<ConversationHistoryEntry>();

  onDelete(event: MouseEvent): void {
    event.stopPropagation();
    this.delete.emit(this.entry());
  }

  shortenPath(path: string): string {
    const parts = path.split('/');
    if (parts.length <= 3) return path;
    return `.../${parts.slice(-2).join('/')}`;
  }
}
