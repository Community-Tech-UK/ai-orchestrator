/**
 * Codebase Stats Component
 *
 * Displays index statistics:
 * - Total files, chunks, embeddings count
 * - Index size display
 * - Last indexed timestamp
 * - Watcher status indicator
 */

import {
  Component,
  input,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { IndexStats, WatcherStatus } from '../../../../shared/types/codebase.types';

@Component({
  selector: 'app-codebase-stats',
  standalone: true,
  template: `
    <div class="stats-container">
      <!-- Stats Grid -->
      <div class="stats-grid">
        <div class="stat-item">
          <span class="stat-value">{{ stats()?.totalFiles || 0 }}</span>
          <span class="stat-label">Files</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ stats()?.totalChunks || 0 }}</span>
          <span class="stat-label">Chunks</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ stats()?.totalEmbeddings || 0 }}</span>
          <span class="stat-label">Embeddings</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ formatBytes(stats()?.indexSize || 0) }}</span>
          <span class="stat-label">Index Size</span>
        </div>
      </div>

      <!-- Meta Info -->
      <div class="stats-meta">
        @if (stats()?.lastIndexedAt) {
          <span class="last-indexed" title="{{ formatFullDate(stats()!.lastIndexedAt) }}">
            Last indexed: {{ formatRelativeTime(stats()!.lastIndexedAt) }}
          </span>
        }

        @if (watcherStatus()) {
          <span class="watcher-status" [class.active]="watcherStatus()!.isWatching">
            <span class="watcher-dot"></span>
            {{ watcherStatus()!.isWatching ? 'Watching' : 'Not watching' }}
            @if (watcherStatus()!.pendingChanges > 0) {
              <span class="pending-badge">{{ watcherStatus()!.pendingChanges }} pending</span>
            }
          </span>
        }
      </div>
    </div>
  `,
  styles: [`
    .stats-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: var(--spacing-md);
    }

    .stat-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }

    .stat-value {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stats-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: var(--spacing-md);
      padding-top: var(--spacing-md);
      border-top: 1px solid var(--border-color);
    }

    .last-indexed {
      font-size: 11px;
      color: var(--text-muted);
    }

    .watcher-status {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 11px;
      color: var(--text-muted);
    }

    .watcher-status.active {
      color: #10b981;
    }

    .watcher-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--text-muted);
    }

    .watcher-status.active .watcher-dot {
      background: #10b981;
      box-shadow: 0 0 4px #10b981;
    }

    .pending-badge {
      padding: 1px 6px;
      background: rgba(245, 158, 11, 0.2);
      color: #f59e0b;
      border-radius: var(--radius-sm);
      font-size: 10px;
    }

    @media (max-width: 480px) {
      .stats-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodebaseStatsComponent {
  /** Index statistics */
  stats = input<IndexStats | null>(null);

  /** File watcher status */
  watcherStatus = input<WatcherStatus | null>(null);

  /** Format bytes to human-readable size */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /** Format timestamp to relative time */
  formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (diff < minute) return 'just now';
    if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
    if (diff < day) return `${Math.floor(diff / hour)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;

    return new Date(timestamp).toLocaleDateString();
  }

  /** Format timestamp to full date */
  formatFullDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}
