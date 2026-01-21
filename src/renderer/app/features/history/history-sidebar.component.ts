/**
 * History Sidebar Component - Slide-out panel for conversation history
 */

import {
  Component,
  inject,
  output,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryListComponent } from './history-list.component';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

@Component({
  selector: 'app-history-sidebar',
  standalone: true,
  imports: [FormsModule, HistoryListComponent],
  template: `
    <div class="history-backdrop" (click)="close.emit()"></div>
    <aside class="history-sidebar" [class.open]="true">
      <div class="sidebar-header">
        <h2>Conversation History</h2>
        <button class="btn-close" (click)="close.emit()" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      <div class="search-container">
        <div class="search-input-wrapper">
          <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            class="search-input"
            placeholder="Search conversations..."
            [ngModel]="store.searchQuery()"
            (ngModelChange)="onSearchChange($event)"
          />
          @if (store.searchQuery()) {
            <button class="btn-clear" (click)="store.clearSearch()" title="Clear search">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          }
        </div>
      </div>

      <div class="list-container">
        <app-history-list
          [entries]="store.filteredEntries()"
          [loading]="store.loading()"
          [searchQuery]="store.searchQuery()"
          (select)="onSelect($event)"
          (delete)="onDelete($event)"
          (clearSearch)="store.clearSearch()"
        />
      </div>

      <div class="sidebar-footer">
        <span class="entry-count">{{ store.entryCount() }} conversations</span>
        @if (store.hasEntries()) {
          <button class="btn-clear-all" (click)="onClearAll()" title="Delete all conversation history">
            Clear All
          </button>
        }
      </div>
    </aside>

    <!-- Confirmation Dialog -->
    @if (showConfirmDialog()) {
      <div class="confirm-overlay" (click)="cancelConfirm()">
        <div class="confirm-dialog" (click)="$event.stopPropagation()">
          <h3>{{ confirmTitle() }}</h3>
          <p>{{ confirmMessage() }}</p>
          <div class="confirm-actions">
            <button class="btn-cancel" (click)="cancelConfirm()" title="Cancel action">Cancel</button>
            <button class="btn-confirm" [class.danger]="confirmDanger()" (click)="executeConfirm()" title="Confirm action">
              {{ confirmAction() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .history-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 999;
    }

    .history-sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      width: 350px;
      background: var(--bg-primary);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      z-index: 1000;
      transform: translateX(-100%);
      transition: transform var(--transition-normal);

      &.open {
        transform: translateX(0);
      }
    }

    .sidebar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md) var(--spacing-lg);
      padding-top: 38px; /* Account for macOS traffic lights */
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
      -webkit-app-region: drag;
    }

    .sidebar-header .btn-close {
      -webkit-app-region: no-drag;
    }

    .sidebar-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .btn-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    }

    .search-container {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .search-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-icon {
      position: absolute;
      left: var(--spacing-sm);
      color: var(--text-muted);
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      padding: var(--spacing-sm) var(--spacing-sm) var(--spacing-sm) 36px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      font-size: 14px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .btn-clear {
      position: absolute;
      right: var(--spacing-xs);
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

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    }

    .list-container {
      flex: 1;
      overflow: hidden;
    }

    .sidebar-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .entry-count {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .btn-clear-all {
      padding: var(--spacing-xs) var(--spacing-sm);
      background: transparent;
      border: 1px solid var(--error-color);
      color: var(--error-color);
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--error-color);
        color: white;
      }
    }

    /* Confirmation Dialog */
    .confirm-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1100;
    }

    .confirm-dialog {
      width: 320px;
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      border-radius: var(--radius-lg);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);

      h3 {
        margin: 0 0 var(--spacing-sm);
        font-size: 16px;
        font-weight: 600;
      }

      p {
        margin: 0 0 var(--spacing-lg);
        font-size: 14px;
        color: var(--text-secondary);
        line-height: 1.5;
      }
    }

    .confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--spacing-sm);
    }

    .btn-cancel {
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-weight: 500;
      cursor: pointer;

      &:hover {
        background: var(--bg-secondary);
      }
    }

    .btn-confirm {
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--primary-color);
      border: none;
      border-radius: var(--radius-sm);
      color: white;
      font-weight: 500;
      cursor: pointer;

      &:hover {
        background: var(--primary-hover);
      }

      &.danger {
        background: var(--error-color);

        &:hover {
          background: #dc2626;
        }
      }
    }
  `],
})
export class HistorySidebarComponent implements OnInit {
  store = inject(HistoryStore);
  instanceStore = inject(InstanceStore);
  close = output<void>();

  // Confirmation dialog state
  showConfirmDialog = signal(false);
  confirmTitle = signal('');
  confirmMessage = signal('');
  confirmAction = signal('');
  confirmDanger = signal(false);
  private confirmCallback: (() => void) | null = null;

  ngOnInit(): void {
    this.store.loadHistory();
  }

  onSearchChange(query: string): void {
    this.store.setSearchQuery(query);
  }

  async onSelect(entry: ConversationHistoryEntry): Promise<void> {
    this.showConfirm(
      'Restore Conversation',
      `This will create a new instance with the conversation history from "${entry.displayName}".`,
      'Restore',
      false,
      async () => {
        const result = await this.store.restoreEntry(entry.id);
        if (result.success && result.instanceId) {
          // Populate the restored messages into the new instance
          if (result.restoredMessages && result.restoredMessages.length > 0) {
            this.instanceStore.setInstanceMessages(
              result.instanceId,
              result.restoredMessages as any[]
            );
          }
          this.instanceStore.setSelectedInstance(result.instanceId);
          this.close.emit();
        }
      }
    );
  }

  onDelete(entry: ConversationHistoryEntry): void {
    this.showConfirm(
      'Delete Conversation',
      `Are you sure you want to delete "${entry.displayName}" from history? This action cannot be undone.`,
      'Delete',
      true,
      () => this.store.deleteEntry(entry.id)
    );
  }

  onClearAll(): void {
    this.showConfirm(
      'Clear All History',
      'Are you sure you want to delete all conversation history? This action cannot be undone.',
      'Clear All',
      true,
      () => this.store.clearAll()
    );
  }

  private showConfirm(
    title: string,
    message: string,
    action: string,
    danger: boolean,
    callback: () => void
  ): void {
    this.confirmTitle.set(title);
    this.confirmMessage.set(message);
    this.confirmAction.set(action);
    this.confirmDanger.set(danger);
    this.confirmCallback = callback;
    this.showConfirmDialog.set(true);
  }

  cancelConfirm(): void {
    this.showConfirmDialog.set(false);
    this.confirmCallback = null;
  }

  executeConfirm(): void {
    if (this.confirmCallback) {
      this.confirmCallback();
    }
    this.showConfirmDialog.set(false);
    this.confirmCallback = null;
  }
}
