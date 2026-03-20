/**
 * History List Component - Scrollable list of history entries
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { HistoryItemComponent } from './history-item.component';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

const INITIAL_DISPLAY_LIMIT = 10;

@Component({
  selector: 'app-history-list',
  standalone: true,
  imports: [HistoryItemComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
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
        @for (entry of visibleEntries(); track entry.id) {
          <app-history-item
            [entry]="entry"
            (selectEntry)="selectEntry.emit($event)"
            (deleteEntry)="deleteEntry.emit($event)"
          />
        }
        @if (hasMore()) {
          <button class="btn-show-more" (click)="expanded.set(true)">
            Show more
          </button>
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

    .btn-show-more {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 13px;
      cursor: pointer;
      padding: var(--spacing-xs) var(--spacing-sm);
      text-align: left;
      transition: color var(--transition-fast);

      &:hover {
        color: var(--text-primary);
      }
    }
  `],
})
export class HistoryListComponent {
  entries = input.required<ConversationHistoryEntry[]>();
  loading = input(false);
  searchQuery = input('');

  expanded = signal(false);

  visibleEntries = computed(() => {
    const all = this.entries();
    // When searching or expanded, show everything
    if (this.searchQuery() || this.expanded()) {
      return all;
    }
    return all.slice(0, INITIAL_DISPLAY_LIMIT);
  });

  hasMore = computed(() => {
    return !this.searchQuery() && !this.expanded() && this.entries().length > INITIAL_DISPLAY_LIMIT;
  });

  selectEntry = output<ConversationHistoryEntry>();
  deleteEntry = output<ConversationHistoryEntry>();
  clearSearch = output<void>();
}
