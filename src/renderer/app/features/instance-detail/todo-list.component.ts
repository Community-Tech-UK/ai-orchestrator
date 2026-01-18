/**
 * TODO List Component - Displays session-scoped task progress
 *
 * Shows a compact view of AI tasks with progress tracking.
 */

import {
  Component,
  inject,
  input,
  signal,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TodoStore } from '../../core/state/todo.store';
import type { TodoItem, TodoStatus } from '../../../../shared/types/todo.types';

@Component({
  selector: 'app-todo-list',
  standalone: true,
  template: `
    @if (store.hasTodos()) {
      <div class="todo-container" [class.collapsed]="collapsed()">
        <!-- Header with progress -->
        <button class="todo-header" (click)="toggleCollapsed()">
          <div class="header-left">
            <span class="toggle-icon">{{ collapsed() ? '▸' : '▾' }}</span>
            <span class="header-title">Tasks</span>
            @if (store.isWorking()) {
              <span class="working-indicator" title="Working...">⚡</span>
            }
          </div>
          <div class="header-stats">
            <span class="stat-text">
              {{ store.stats().completed }}/{{ store.stats().total }}
            </span>
            <div class="progress-bar">
              <div
                class="progress-fill"
                [style.width.%]="store.stats().percentComplete"
              ></div>
            </div>
          </div>
        </button>

        <!-- Current task highlight (always visible when working) -->
        @if (store.currentTodo(); as current) {
          <div class="current-task">
            <span class="current-icon">▶</span>
            <span class="current-text">{{ current.activeForm || current.content }}</span>
          </div>
        }

        <!-- Expandable task list -->
        @if (!collapsed()) {
          <div class="todo-list">
            @for (todo of store.visibleTodos(); track todo.id) {
              <div class="todo-item" [class]="'status-' + todo.status">
                <span class="todo-status">{{ getStatusIcon(todo.status) }}</span>
                <span class="todo-content">{{ todo.content }}</span>
              </div>
            }

            @if (store.stats().completed > 0 && !store.showCompleted()) {
              <button class="show-completed-btn" (click)="store.toggleShowCompleted()">
                Show {{ store.stats().completed }} completed
              </button>
            }
            @if (store.stats().completed > 0 && store.showCompleted()) {
              <button class="show-completed-btn" (click)="store.toggleShowCompleted()">
                Hide completed
              </button>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .todo-container {
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        overflow: hidden;
        border: 1px solid var(--border-color);
      }

      .todo-header {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: background var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .toggle-icon {
        font-size: 10px;
        color: var(--text-muted);
        width: 12px;
      }

      .header-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .working-indicator {
        animation: pulse 1.5s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      .header-stats {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .stat-text {
        font-size: 11px;
        color: var(--text-secondary);
        font-weight: 500;
      }

      .progress-bar {
        width: 60px;
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: var(--success-color);
        border-radius: 2px;
        transition: width 0.3s ease;
      }

      .current-task {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--primary-color-alpha, rgba(59, 130, 246, 0.1));
        border-top: 1px solid var(--border-color);
        font-size: 13px;
      }

      .current-icon {
        color: var(--primary-color);
        font-size: 10px;
      }

      .current-text {
        color: var(--text-primary);
        font-weight: 500;
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .todo-list {
        border-top: 1px solid var(--border-color);
        max-height: 200px;
        overflow-y: auto;
      }

      .todo-item {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: 12px;
        border-bottom: 1px solid var(--border-subtle);

        &:last-child {
          border-bottom: none;
        }

        &.status-completed {
          opacity: 0.6;

          .todo-content {
            text-decoration: line-through;
          }
        }

        &.status-cancelled {
          opacity: 0.4;

          .todo-content {
            text-decoration: line-through;
          }
        }

        &.status-in_progress {
          background: var(--primary-color-alpha, rgba(59, 130, 246, 0.05));
        }
      }

      .todo-status {
        font-size: 12px;
        flex-shrink: 0;
        width: 16px;
        text-align: center;
      }

      .todo-content {
        color: var(--text-primary);
        line-height: 1.4;
      }

      .show-completed-btn {
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        background: transparent;
        border: none;
        color: var(--text-muted);
        font-size: 11px;
        cursor: pointer;
        text-align: center;

        &:hover {
          color: var(--text-secondary);
          background: var(--bg-hover);
        }
      }

      /* Collapsed state */
      .collapsed .todo-header {
        border-radius: var(--radius-md);
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TodoListComponent {
  store = inject(TodoStore);

  /** Session ID to display TODOs for */
  sessionId = input<string | null>(null);

  /** Collapsed state */
  collapsed = signal(false);

  constructor() {
    // Sync session ID with store
    effect(() => {
      const id = this.sessionId();
      this.store.setSession(id);
    });
  }

  toggleCollapsed(): void {
    this.collapsed.update((v) => !v);
  }

  getStatusIcon(status: TodoStatus): string {
    switch (status) {
      case 'pending':
        return '○';
      case 'in_progress':
        return '◐';
      case 'completed':
        return '✓';
      case 'cancelled':
        return '✗';
      default:
        return '○';
    }
  }
}
