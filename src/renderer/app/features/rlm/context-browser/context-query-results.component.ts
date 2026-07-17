/**
 * Context Query Results Component - Query results list and detail panel
 */

import {
  Component,
  input,
  output,
  ChangeDetectionStrategy
} from '@angular/core';
import type { QueryType } from '../../../../../shared/types/rlm.types';

export interface QueryResult {
  id: string;
  type: QueryType;
  content: string;
  tokens: number;
  sections: string[];
  timestamp: number;
  duration: number;
  error?: string;
}

@Component({
  selector: 'app-context-query-results',
  standalone: true,
  template: `
    <!-- Results List -->
    <div class="query-results-section">
      <div class="results-header">
        <span class="results-title">Query Results</span>
        <span class="results-count">{{ results().length }} results</span>
        <button class="clear-results-btn" (click)="clearResults.emit()">
          Clear
        </button>
      </div>
      <div class="results-list">
        @for (result of results(); track result.id) {
          <div
            class="result-item"
            [class.active]="activeResultId() === result.id"
            [class.error]="result.error"
            (click)="selectResult.emit(result)"
            (keydown.enter)="selectResult.emit(result)"
            (keydown.space)="selectResult.emit(result)"
            tabindex="0"
            role="button"
          >
            <div class="result-header">
              <span class="result-type"
                >{{ result.type }}</span
              >
              <span class="result-time">{{
                formatRelativeTime(result.timestamp)
              }}</span>
            </div>
            <div class="result-preview">
              {{ truncateContent(result.error || result.content) }}
            </div>
            <div class="result-meta">
              <span class="result-tokens">{{ result.tokens }} tokens</span>
              <span class="result-duration">{{ result.duration }}ms</span>
              @if (result.sections.length > 0) {
                <span class="result-sections"
                  >{{ result.sections.length }} sections</span
                >
              }
            </div>
          </div>
        }
      </div>
    </div>

    <!-- Active Result Detail -->
    @if (activeResult(); as result) {
      <div class="result-detail-panel">
        <div class="detail-header">
          <span class="detail-title">
            {{ result.type }} Result
          </span>
          <button class="close-btn" (click)="closeDetail.emit()">✕</button>
        </div>
        <div class="detail-content">
          @if (result.error) {
            <div class="error-display">
              <span class="error-message">{{ result.error }}</span>
            </div>
          } @else {
            <pre class="result-content-pre">{{ result.content }}</pre>
          }
        </div>
        <div class="detail-footer">
          <div class="result-stats">
            <span>{{ result.tokens }} tokens</span>
            <span>{{ result.duration }}ms</span>
            <span>{{ result.sections.length }} sections accessed</span>
          </div>
          <div class="result-actions">
            @if (!result.error) {
              <button
                class="action-btn"
                (click)="copyToClipboard.emit(result.content)"
              >
                Copy
              </button>
            }
            @if (result.sections.length > 0) {
              <button class="action-btn" (click)="showSections.emit(result)">
                View Sections
              </button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      .query-results-section {
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      .results-header {
        display: flex;
        align-items: center;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .results-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
      }

      .results-count {
        font-size: 11px;
        color: var(--text-muted);
        margin-right: var(--spacing-sm);
      }

      .clear-results-btn {
        padding: 2px 8px;
        background: var(--bg-secondary);
        border: none;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        font-size: 10px;
        cursor: pointer;

        &:hover {
          background: var(--bg-hover);
        }
      }

      .results-list {
        max-height: 200px;
        overflow-y: auto;
      }

      .result-item {
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--bg-hover);
        }

        &.active {
          background: var(--bg-secondary);
          border: 1px solid rgba(var(--primary-rgb), 0.3);
        }

        &.error {
          background: rgba(239, 68, 68, 0.1);

          .result-type {
            color: #ef4444;
          }
        }
      }

      .result-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 4px;
      }

      .result-type {
        font-size: 11px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .result-time {
        font-size: 10px;
        color: var(--text-muted);
      }

      .result-preview {
        font-size: 11px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 4px;
      }

      .result-meta {
        display: flex;
        gap: var(--spacing-md);
        font-size: 10px;
        color: var(--text-muted);
      }

      .result-detail-panel {
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-secondary);
        max-height: 350px;
        display: flex;
        flex-direction: column;
      }

      .detail-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
      }

      .detail-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .close-btn {
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: 16px;
        cursor: pointer;

        &:hover {
          color: var(--text-primary);
        }
      }

      .detail-content {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-md);
      }

      .result-content-pre {
        margin: 0;
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-primary);
        white-space: pre-wrap;
        line-height: 1.5;
      }

      .error-display {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        background: rgba(239, 68, 68, 0.1);
        border-radius: var(--radius-sm);
      }

      .error-message {
        color: #ef4444;
        font-size: 12px;
      }

      .detail-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-sm) var(--spacing-md);
        border-top: 1px solid var(--border-color);
      }

      .result-stats {
        display: flex;
        gap: var(--spacing-md);
        font-size: 10px;
        color: var(--text-muted);
      }

      .result-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      .action-btn {
        padding: 6px 12px;
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: var(--bg-hover);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContextQueryResultsComponent {
  results = input.required<QueryResult[]>();
  activeResult = input<QueryResult | null>(null);
  activeResultId = input<string | null>(null);

  selectResult = output<QueryResult>();
  clearResults = output<void>();
  closeDetail = output<void>();
  copyToClipboard = output<string>();
  showSections = output<QueryResult>();

  formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    if (seconds > 0) return `${seconds}s ago`;
    return 'just now';
  }

  truncateContent(content: string): string {
    if (content.length <= 100) return content;
    return content.slice(0, 100) + '...';
  }
}
