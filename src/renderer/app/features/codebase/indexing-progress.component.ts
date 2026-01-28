/**
 * Indexing Progress Component
 *
 * Displays the current indexing progress with:
 * - Progress bar with percentage
 * - Current file being processed
 * - Status label (scanning/chunking/embedding/complete)
 * - Cancel button
 */

import {
  Component,
  input,
  output,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import type { IndexingProgress, IndexingStatus } from '../../../../shared/types/codebase.types';

@Component({
  selector: 'app-indexing-progress',
  standalone: true,
  template: `
    <div class="progress-container" [class.active]="isActive()">
      <!-- Status Header -->
      <div class="progress-header">
        <div class="status-info">
          <span class="status-badge" [class]="statusClass()">
            {{ statusLabel() }}
          </span>
          @if (progress()?.eta && isActive()) {
            <span class="eta">ETA: {{ formatEta(progress()!.eta!) }}</span>
          }
        </div>
        @if (isActive()) {
          <button class="cancel-btn" (click)="cancel.emit()" title="Cancel indexing">
            Cancel
          </button>
        }
      </div>

      <!-- Progress Bar -->
      <div class="progress-bar-container">
        <div class="progress-bar" [style.width.%]="progressPercent()"></div>
      </div>

      <!-- Progress Details -->
      <div class="progress-details">
        <span class="files-count">
          {{ progress()?.processedFiles || 0 }} / {{ progress()?.totalFiles || 0 }} files
        </span>
        @if (progress()?.totalChunks) {
          <span class="chunks-count">
            {{ progress()?.embeddedChunks || 0 }} / {{ progress()?.totalChunks }} chunks embedded
          </span>
        }
      </div>

      <!-- Current File -->
      @if (progress()?.currentFile && isActive()) {
        <div class="current-file" title="{{ progress()!.currentFile }}">
          <span class="file-icon">📄</span>
          <span class="file-path">{{ truncatePath(progress()!.currentFile!) }}</span>
        </div>
      }

      <!-- Error Message -->
      @if (progress()?.errorMessage) {
        <div class="error-message">
          <span class="error-icon">⚠</span>
          {{ progress()!.errorMessage }}
        </div>
      }
    </div>
  `,
  styles: [`
    .progress-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .progress-container.active {
      border-color: var(--primary-color);
    }

    .progress-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .status-info {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .status-badge.idle {
      background: var(--bg-tertiary);
      color: var(--text-muted);
    }

    .status-badge.scanning {
      background: rgba(59, 130, 246, 0.2);
      color: #3b82f6;
    }

    .status-badge.chunking {
      background: rgba(168, 85, 247, 0.2);
      color: #a855f7;
    }

    .status-badge.embedding {
      background: rgba(245, 158, 11, 0.2);
      color: #f59e0b;
    }

    .status-badge.complete {
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
    }

    .status-badge.error {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    .status-badge.cancelled {
      background: rgba(107, 114, 128, 0.2);
      color: #6b7280;
    }

    .eta {
      font-size: 11px;
      color: var(--text-muted);
    }

    .cancel-btn {
      padding: 4px 10px;
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: rgba(239, 68, 68, 0.1);
        border-color: #ef4444;
        color: #ef4444;
      }
    }

    .progress-bar-container {
      height: 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--primary-color), #60a5fa);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .progress-details {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
    }

    .current-file {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 11px;
      color: var(--text-secondary);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .file-icon {
      flex-shrink: 0;
    }

    .file-path {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .error-message {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      color: #ef4444;
      padding: var(--spacing-sm);
      background: rgba(239, 68, 68, 0.1);
      border-radius: var(--radius-sm);
    }

    .error-icon {
      flex-shrink: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IndexingProgressComponent {
  /** Current indexing progress */
  progress = input<IndexingProgress | null>(null);

  /** Cancel event */
  cancel = output<void>();

  /** Whether indexing is active */
  isActive = computed(() => {
    const status = this.progress()?.status;
    return status === 'scanning' || status === 'chunking' || status === 'embedding';
  });

  /** Progress percentage */
  progressPercent = computed(() => {
    const p = this.progress();
    if (!p || p.totalFiles === 0) return 0;
    return Math.round((p.processedFiles / p.totalFiles) * 100);
  });

  /** Status CSS class */
  statusClass = computed(() => {
    return this.progress()?.status || 'idle';
  });

  /** Human-readable status label */
  statusLabel = computed(() => {
    const statusMap: Record<IndexingStatus, string> = {
      idle: 'Idle',
      scanning: 'Scanning',
      chunking: 'Chunking',
      embedding: 'Embedding',
      complete: 'Complete',
      error: 'Error',
      cancelled: 'Cancelled',
    };
    return statusMap[this.progress()?.status || 'idle'];
  });

  /** Format ETA in human-readable format */
  formatEta(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  /** Truncate file path for display */
  truncatePath(path: string, maxLength = 50): string {
    if (path.length <= maxLength) return path;
    const parts = path.split('/');
    if (parts.length <= 2) return `...${path.slice(-maxLength + 3)}`;

    // Show first and last parts
    const first = parts[0];
    const last = parts.slice(-2).join('/');
    if (first.length + last.length + 5 <= maxLength) {
      return `${first}/.../${last}`;
    }
    return `.../${last}`;
  }
}
