/**
 * History List Component - Scrollable list of history entries
 */

import { Component, input, output } from '@angular/core';
import { HistoryItemComponent } from './history-item.component';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

@Component({
  selector: 'app-history-list',
  standalone: true,
  imports: [HistoryItemComponent],
  template: `
    @if (loading()) {
      <div class="loading-state">
        <div class="loading-spinner"></div>
        <span>Loading history...</span>
      </div>
    } @else if (entries().length === 0) {
      <div class="empty-state">
        @if (searchQuery()) {
          <p>No conversations match your search</p>
          <button class="btn-clear-search" (click)="clearSearch.emit()">
            Clear search
          </button>
        } @else {
          <p>No conversation history yet</p>
          <span class="empty-hint">Conversations will appear here after you close an instance</span>
        }
      </div>
    } @else {
      <div class="history-list">
        @for (entry of entries(); track entry.id) {
          <app-history-item
            [entry]="entry"
            (select)="select.emit($event)"
            (delete)="delete.emit($event)"
          />
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      overflow-y: auto;
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-xl);
      gap: var(--spacing-md);
      color: var(--text-secondary);
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-color);
      border-top-color: var(--primary-color);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--spacing-xl);
      text-align: center;
      color: var(--text-secondary);

      p {
        margin: 0 0 var(--spacing-sm);
        font-size: 14px;
      }

      .empty-hint {
        font-size: 12px;
        color: var(--text-muted);
      }
    }

    .btn-clear-search {
      margin-top: var(--spacing-md);
      padding: var(--spacing-xs) var(--spacing-md);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;

      &:hover {
        background: var(--bg-secondary);
      }
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm);
    }
  `],
})
export class HistoryListComponent {
  entries = input.required<ConversationHistoryEntry[]>();
  loading = input(false);
  searchQuery = input('');

  select = output<ConversationHistoryEntry>();
  delete = output<ConversationHistoryEntry>();
  clearSearch = output<void>();
}
