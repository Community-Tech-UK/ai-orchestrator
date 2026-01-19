/**
 * Worktree Panel Component
 *
 * Git worktree management for parallel agent work:
 * - List active worktrees
 * - Status per worktree
 * - File change counts
 * - Branch names
 * - Action buttons (view changes, merge, abandon)
 */

import {
  Component,
  Pipe,
  PipeTransform,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type {
  WorktreeSession,
  WorktreeStatus,
} from '../../../../shared/types/worktree.types';

// Simple pipe for truncating paths
@Pipe({
  name: 'truncatePath',
  standalone: true,
})
export class TruncatePathPipe implements PipeTransform {
  transform(path: string): string {
    if (!path) return '';
    const parts = path.split('/');
    if (parts.length <= 3) return path;
    return `.../${parts.slice(-2).join('/')}`;
  }
}

interface WorktreeAction {
  sessionId: string;
  action: 'view' | 'merge' | 'abandon' | 'complete';
}

@Component({
  selector: 'app-worktree-panel',
  standalone: true,
  imports: [TruncatePathPipe],
  template: `
    <div class="worktree-container">
      <!-- Header -->
      <div class="worktree-header">
        <div class="header-left">
          <span class="worktree-icon">🌳</span>
          <span class="worktree-title">Worktrees</span>
          <span class="worktree-count">{{ sessions().length }} active</span>
        </div>
        @if (sessions().length > 0) {
          <button
            class="merge-all-btn"
            [disabled]="!canMergeAll()"
            (click)="onMergeAll()"
          >
            Merge All
          </button>
        }
      </div>

      <!-- Worktree List -->
      @if (sessions().length > 0) {
        <div class="worktree-list">
          @for (session of sessions(); track session.id) {
            <div
              class="worktree-item"
              [class]="'status-' + session.status"
              [class.selected]="selectedId() === session.id"
              (click)="selectWorktree(session)"
            >
              <!-- Status Indicator -->
              <div class="status-indicator" [title]="session.status">
                {{ getStatusIcon(session.status) }}
              </div>

              <!-- Info -->
              <div class="worktree-info">
                <div class="worktree-name">
                  <span class="branch-name">{{ session.branchName }}</span>
                  @if (session.taskDescription) {
                    <span class="description">{{ session.taskDescription }}</span>
                  }
                </div>
                <div class="worktree-meta">
                  <span class="meta-item">
                    📁 {{ session.worktreePath | truncatePath }}
                  </span>
                  @if (session.filesChanged && session.filesChanged.length > 0) {
                    <span class="meta-item changes">
                      {{ session.filesChanged.length }} files changed
                    </span>
                  }
                  @if (session.createdAt) {
                    <span class="meta-item time">
                      {{ formatTime(session.createdAt) }}
                    </span>
                  }
                </div>
              </div>

              <!-- Progress -->
              @if (session.status === 'active') {
                <div class="progress-indicator">
                  <div class="spinner"></div>
                </div>
              }

              <!-- Actions -->
              <div class="worktree-actions">
                @if (session.filesChanged && session.filesChanged.length > 0) {
                  <button
                    class="action-btn"
                    title="View Changes"
                    (click)="onAction(session.id, 'view'); $event.stopPropagation()"
                  >
                    👁
                  </button>
                }
                @if (session.status === 'active') {
                  <button
                    class="action-btn"
                    title="Mark Complete"
                    (click)="onAction(session.id, 'complete'); $event.stopPropagation()"
                  >
                    ✓
                  </button>
                }
                @if (session.status === 'completed') {
                  <button
                    class="action-btn primary"
                    title="Merge"
                    (click)="onAction(session.id, 'merge'); $event.stopPropagation()"
                  >
                    ⎇
                  </button>
                }
                <button
                  class="action-btn danger"
                  title="Abandon"
                  (click)="onAction(session.id, 'abandon'); $event.stopPropagation()"
                >
                  ✕
                </button>
              </div>
            </div>
          }
        </div>

        <!-- Selected Details -->
        @if (selectedSession(); as session) {
          <div class="session-details">
            <div class="details-header">
              <span class="details-title">{{ session.branchName }}</span>
              <span class="status-badge" [class]="'status-' + session.status">
                {{ session.status }}
              </span>
            </div>

            @if (session.taskDescription) {
              <p class="details-description">{{ session.taskDescription }}</p>
            }

            <div class="details-section">
              <span class="section-label">Path</span>
              <code class="path-value">{{ session.worktreePath }}</code>
            </div>

            @if (session.baseBranch) {
              <div class="details-section">
                <span class="section-label">Base Branch</span>
                <span class="base-branch">{{ session.baseBranch }}</span>
              </div>
            }

            @if (session.filesChanged && session.filesChanged.length > 0) {
              <div class="details-section">
                <span class="section-label">
                  Changed Files ({{ session.filesChanged.length }})
                </span>
                <div class="files-list">
                  @for (file of session.filesChanged.slice(0, 10); track file) {
                    <div class="file-item">
                      <span class="file-icon">📄</span>
                      <span class="file-name">{{ file }}</span>
                    </div>
                  }
                  @if (session.filesChanged.length > 10) {
                    <div class="files-more">
                      +{{ session.filesChanged.length - 10 }} more files
                    </div>
                  }
                </div>
              </div>
            }

            <div class="details-actions">
              @if (session.status === 'completed') {
                <button
                  class="details-btn primary"
                  (click)="onAction(session.id, 'merge')"
                >
                  Merge to Main
                </button>
              }
              @if (session.filesChanged && session.filesChanged.length > 0) {
                <button
                  class="details-btn secondary"
                  (click)="onAction(session.id, 'view')"
                >
                  View Diff
                </button>
              }
              <button
                class="details-btn danger"
                (click)="onAction(session.id, 'abandon')"
              >
                Abandon
              </button>
            </div>
          </div>
        }
      } @else {
        <div class="empty-state">
          <span class="empty-icon">🌳</span>
          <span class="empty-text">No active worktrees</span>
          <span class="empty-hint">
            Worktrees are created when agents work on parallel tasks
          </span>
        </div>
      }
    </div>
  `,
  styles: [`
    .worktree-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
    }

    .worktree-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .worktree-icon {
      font-size: 18px;
    }

    .worktree-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .worktree-count {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .merge-all-btn {
      padding: 6px 12px;
      background: var(--primary-color);
      border: none;
      border-radius: var(--radius-sm);
      color: white;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .worktree-list {
      display: flex;
      flex-direction: column;
    }

    .worktree-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:last-child {
        border-bottom: none;
      }

      &:hover {
        background: var(--bg-hover);
      }

      &.selected {
        background: var(--bg-tertiary);
      }

      &.status-active .status-indicator {
        animation: pulse 1.5s ease-in-out infinite;
      }

      &.status-completed .status-indicator {
        color: var(--success-color);
      }

      &.status-merged .status-indicator {
        color: var(--primary-color);
      }

      &.status-conflict .status-indicator {
        color: var(--error-color);
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .status-indicator {
      font-size: 16px;
      width: 24px;
      text-align: center;
    }

    .worktree-info {
      flex: 1;
      min-width: 0;
    }

    .worktree-name {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .branch-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .description {
      font-size: 11px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .worktree-meta {
      display: flex;
      gap: var(--spacing-sm);
      margin-top: 2px;
    }

    .meta-item {
      font-size: 10px;
      color: var(--text-muted);

      &.changes {
        color: var(--warning-color);
      }

      &.time {
        color: var(--text-muted);
      }
    }

    .progress-indicator {
      width: 16px;
      height: 16px;
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--bg-tertiary);
      border-top-color: var(--primary-color);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .worktree-actions {
      display: flex;
      gap: 4px;
    }

    .action-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.primary:hover {
        background: var(--primary-color);
        color: white;
      }

      &.danger:hover {
        background: var(--error-color);
        color: white;
      }
    }

    /* Session Details */
    .session-details {
      padding: var(--spacing-md);
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border-color);
    }

    .details-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-sm);
    }

    .details-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;

      &.status-active {
        background: var(--primary-color);
        color: white;
      }

      &.status-completed {
        background: var(--success-color);
        color: white;
      }

      &.status-merged {
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }

      &.status-conflict {
        background: var(--error-color);
        color: white;
      }
    }

    .details-description {
      margin: 0 0 var(--spacing-sm) 0;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .details-section {
      margin-bottom: var(--spacing-sm);
    }

    .section-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }

    .path-value {
      display: block;
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-secondary);
      padding: var(--spacing-xs);
      border-radius: var(--radius-sm);
      word-break: break-all;
    }

    .base-branch {
      font-size: 12px;
      color: var(--text-primary);
      font-family: var(--font-mono);
    }

    .files-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 150px;
      overflow-y: auto;
    }

    .file-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 11px;
    }

    .file-icon {
      font-size: 12px;
    }

    .file-name {
      color: var(--text-secondary);
      font-family: var(--font-mono);
    }

    .files-more {
      font-size: 10px;
      color: var(--text-muted);
      padding: var(--spacing-xs) 0;
    }

    .details-actions {
      display: flex;
      gap: var(--spacing-xs);
      margin-top: var(--spacing-md);
    }

    .details-btn {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &.primary {
        background: var(--primary-color);
        border: none;
        color: white;

        &:hover {
          background: var(--primary-hover);
        }
      }

      &.secondary {
        background: transparent;
        border: 1px solid var(--border-color);
        color: var(--text-secondary);

        &:hover {
          background: var(--bg-hover);
          color: var(--text-primary);
        }
      }

      &.danger {
        background: transparent;
        border: 1px solid var(--error-color);
        color: var(--error-color);

        &:hover {
          background: var(--error-color);
          color: white;
        }
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 14px;
      color: var(--text-secondary);
    }

    .empty-hint {
      font-size: 12px;
      color: var(--text-muted);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorktreePanelComponent {
  /** Worktree sessions */
  sessions = input<WorktreeSession[]>([]);

  /** Action event */
  action = output<WorktreeAction>();

  /** Merge all event */
  mergeAll = output<void>();

  /** Selected worktree ID */
  selectedId = signal<string | null>(null);

  /** Selected session */
  selectedSession = computed(() => {
    const id = this.selectedId();
    if (!id) return null;
    return this.sessions().find((s) => s.id === id) || null;
  });

  /** Can merge all */
  canMergeAll = computed(() =>
    this.sessions().some((s) => s.status === 'completed')
  );

  getStatusIcon(status: WorktreeStatus): string {
    switch (status) {
      case 'active':
        return '🔄';
      case 'completed':
        return '✅';
      case 'merged':
        return '✓';
      case 'conflict':
        return '⚠️';
      case 'abandoned':
        return '❌';
      default:
        return '○';
    }
  }

  formatTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  selectWorktree(session: WorktreeSession): void {
    this.selectedId.set(
      this.selectedId() === session.id ? null : session.id
    );
  }

  onAction(sessionId: string, action: WorktreeAction['action']): void {
    this.action.emit({ sessionId, action });
  }

  onMergeAll(): void {
    this.mergeAll.emit();
  }
}
