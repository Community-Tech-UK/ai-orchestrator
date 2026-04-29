/**
 * Search Results Component
 *
 * Displays search results with:
 * - Virtual scroll for large result sets
 * - Syntax highlighting via existing highlight utility
 * - Score badge (BM25/vector/hybrid indicator)
 * - File path and line range display
 * - Copy-to-clipboard action
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import type { HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';

@Component({
  selector: 'app-search-results',
  standalone: true,
  template: `
    <div class="results-container">
      <!-- Results Header -->
      <div class="results-header">
        <span class="results-count">{{ results().length }} results</span>
        @if (results().length > 0) {
          <button class="clear-btn" (click)="clearResults.emit()">
            Clear
          </button>
        }
      </div>

      <!-- Results List -->
      @if (results().length > 0) {
        <div class="results-list">
          @for (result of visibleResults(); track result.sectionId; let i = $index) {
            <div
              class="result-item"
              [class.selected]="selectedId() === result.sectionId"
              role="button"
              tabindex="0"
              (click)="selectResult(result)"
              (keyup.enter)="selectResult(result)"
              (keyup.space)="selectResult(result)"
            >
              <!-- Result Header -->
              <div class="result-header">
                <div class="file-info">
                  <span class="file-icon">{{ getFileIcon(result.filePath) }}</span>
                  <span class="file-path" title="{{ result.filePath }}">
                    {{ truncatePath(result.filePath) }}
                  </span>
                  @if (result.startLine) {
                    <span class="line-range">
                      :{{ result.startLine }}{{ result.endLine ? '-' + result.endLine : '' }}
                    </span>
                  }
                </div>
                <div class="result-badges">
                  <span class="match-type" [class]="result.matchType">
                    {{ result.matchType }}
                  </span>
                  <span class="score" title="Relevance score">
                    {{ formatScore(result.score) }}
                  </span>
                </div>
              </div>

              <!-- Result Content -->
              <div class="result-content">
                <pre class="code-preview" [class]="getLanguageClass(result.language)">{{ result.content }}</pre>
              </div>

              <!-- Result Footer -->
              <div class="result-footer">
                @if (result.chunkType) {
                  <span class="chunk-type">{{ result.chunkType }}</span>
                }
                @if (result.symbolName) {
                  <span class="symbol-name">{{ result.symbolName }}</span>
                }
                <div class="result-actions">
                  <button
                    class="action-btn"
                    (click)="copyContent(result); $event.stopPropagation()"
                    title="Copy to clipboard"
                  >
                    📋
                  </button>
                  <button
                    class="action-btn"
                    (click)="openFile.emit(result); $event.stopPropagation()"
                    title="Open file"
                  >
                    📂
                  </button>
                </div>
              </div>
            </div>
          }

          <!-- Load More -->
          @if (hasMore()) {
            <button class="load-more-btn" (click)="loadMore()">
              Load more ({{ remainingCount() }} remaining)
            </button>
          }
        </div>
      } @else {
        <div class="no-results">
          <span class="no-results-icon">🔍</span>
          <span class="no-results-text">No results found</span>
          <span class="no-results-hint">Try different search terms or adjust filters</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .results-container {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .results-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-xs) 0;
    }

    .results-count {
      font-size: 12px;
      color: var(--text-muted);
    }

    .clear-btn {
      padding: 2px 8px;
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      max-height: 600px;
      overflow-y: auto;
    }

    .result-item {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-sm);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--primary-color);
      }

      &.selected {
        border-color: var(--primary-color);
        background: rgba(var(--primary-rgb), 0.05);
      }
    }

    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--spacing-sm);
      margin-bottom: var(--spacing-xs);
    }

    .file-info {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      overflow: hidden;
    }

    .file-icon {
      flex-shrink: 0;
      font-size: 14px;
    }

    .file-path {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .line-range {
      font-size: 11px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .result-badges {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-shrink: 0;
    }

    .match-type {
      padding: 1px 6px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 500;
      text-transform: uppercase;

      &.bm25 {
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
      }

      &.vector {
        background: rgba(168, 85, 247, 0.2);
        color: #a855f7;
      }

      &.hybrid {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;
      }
    }

    .score {
      padding: 1px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-muted);
      font-family: monospace;
    }

    .result-content {
      margin: var(--spacing-xs) 0;
    }

    .code-preview {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-family: 'Fira Code', 'Monaco', monospace;
      font-size: 11px;
      line-height: 1.5;
      color: var(--text-primary);
      overflow-x: auto;
      max-height: 150px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .result-footer {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      margin-top: var(--spacing-xs);
    }

    .chunk-type,
    .symbol-name {
      padding: 1px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-muted);
    }

    .symbol-name {
      font-family: monospace;
    }

    .result-actions {
      display: flex;
      gap: var(--spacing-xs);
      margin-left: auto;
    }

    .action-btn {
      padding: 2px 6px;
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        border-color: var(--text-muted);
      }
    }

    .load-more-btn {
      padding: var(--spacing-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      text-align: center;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .no-results {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
    }

    .no-results-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .no-results-text {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .no-results-hint {
      font-size: 12px;
      color: var(--text-muted);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchResultsComponent {
  private clipboard = inject(CLIPBOARD_SERVICE);

  /** Search results to display */
  results = input<HybridSearchResult[]>([]);

  /** Selected result ID */
  selectedId = input<string | null>(null);

  /** Result selected event */
  resultSelected = output<HybridSearchResult>();

  /** Clear results event */
  clearResults = output<void>();

  /** Open file event */
  openFile = output<HybridSearchResult>();

  /** Copy success event */
  copySuccess = output<string>();

  // Pagination state
  private pageSize = 20;
  displayCount = signal(20);

  visibleResults = computed(() => {
    return this.results().slice(0, this.displayCount());
  });

  hasMore = computed(() => {
    return this.results().length > this.displayCount();
  });

  remainingCount = computed(() => {
    return Math.max(0, this.results().length - this.displayCount());
  });

  selectResult(result: HybridSearchResult): void {
    this.resultSelected.emit(result);
  }

  loadMore(): void {
    this.displayCount.update(count => count + this.pageSize);
  }

  async copyContent(result: HybridSearchResult): Promise<void> {
    const copyResult = await this.clipboard.copyText(result.content, { label: 'search result' });
    if (copyResult.ok) {
      this.copySuccess.emit('Copied to clipboard');
    } else {
      console.error('Failed to copy to clipboard:', copyResult.reason, copyResult.cause);
    }
  }

  formatScore(score: number): string {
    return score.toFixed(3);
  }

  truncatePath(path: string, maxLength = 40): string {
    if (path.length <= maxLength) return path;
    const parts = path.split('/');
    if (parts.length <= 2) return `...${path.slice(-maxLength + 3)}`;
    const fileName = parts[parts.length - 1];
    const parentDir = parts[parts.length - 2];
    return `.../${parentDir}/${fileName}`;
  }

  getFileIcon(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const iconMap: Record<string, string> = {
      ts: '📘',
      tsx: '📘',
      js: '📒',
      jsx: '📒',
      py: '🐍',
      rs: '🦀',
      go: '🔵',
      java: '☕',
      rb: '💎',
      php: '🐘',
      css: '🎨',
      scss: '🎨',
      html: '🌐',
      json: '📋',
      md: '📝',
      yaml: '⚙️',
      yml: '⚙️',
      sql: '🗃️',
    };
    return iconMap[ext || ''] || '📄';
  }

  getLanguageClass(language?: string): string {
    return language ? `language-${language}` : '';
  }
}
