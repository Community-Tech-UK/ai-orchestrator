/**
 * Codebase Search Component
 *
 * Search input with options:
 * - Text input with debounced search (300ms)
 * - Toggle switch for HyDE query expansion
 * - File pattern filter input (glob patterns)
 * - Emits HybridSearchOptions to parent
 */

import {
  Component,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { HybridSearchOptions } from '../../../../shared/types/codebase.types';

@Component({
  selector: 'app-codebase-search',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="search-container">
      <!-- Search Input -->
      <div class="search-input-wrapper">
        <label for="codebase-search-input" class="visually-hidden">Search</label>
        <input
          type="text"
          id="codebase-search-input"
          class="search-input"
          placeholder="Search codebase..."
          [ngModel]="searchQuery()"
          (ngModelChange)="onQueryChange($event)"
          [disabled]="disabled()"
        />
        @if (searchQuery()) {
          <button class="clear-btn" (click)="clearSearch()" title="Clear search">
            ✕
          </button>
        }
      </div>

      <!-- Search Options -->
      <div class="search-options">
        <!-- HyDE Toggle -->
        <label class="option-toggle" for="hyde-toggle" title="Hypothetical Document Embedding - generates better semantic queries">
          <input
            type="checkbox"
            id="hyde-toggle"
            [ngModel]="useHyDE()"
            (ngModelChange)="useHyDE.set($event); triggerSearch()"
            [disabled]="disabled()"
          />
          <span class="toggle-label">HyDE</span>
        </label>

        <!-- File Pattern Filter -->
        <div class="file-pattern">
          <label for="file-pattern-input" class="visually-hidden">File pattern filter</label>
          <input
            type="text"
            id="file-pattern-input"
            class="pattern-input"
            placeholder="*.ts, src/**"
            [ngModel]="filePattern()"
            (ngModelChange)="onPatternChange($event)"
            [disabled]="disabled()"
            title="Filter by file patterns (comma-separated glob patterns)"
          />
        </div>

        <!-- Result Count -->
        <div class="result-count">
          <label class="count-label" for="result-count-select">Results:</label>
          <select
            id="result-count-select"
            class="count-select"
            [ngModel]="topK()"
            (ngModelChange)="topK.set($event); triggerSearch()"
            [disabled]="disabled()"
          >
            <option [ngValue]="10">10</option>
            <option [ngValue]="25">25</option>
            <option [ngValue]="50">50</option>
            <option [ngValue]="100">100</option>
          </select>
        </div>
      </div>

      <!-- Loading Indicator -->
      @if (isSearching()) {
        <div class="searching-indicator">
          <span class="spinner"></span>
          Searching...
        </div>
      }
    </div>
  `,
  styles: [`
    .search-container {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .search-input-wrapper {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-sm) var(--spacing-md);
      transition: border-color var(--transition-fast);

      &:focus-within {
        border-color: var(--primary-color);
      }
    }

    .search-input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      outline: none;

      &::placeholder {
        color: var(--text-muted);
      }

      &:disabled {
        opacity: 0.5;
      }
    }

    .clear-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 12px;
      padding: 2px 4px;
      border-radius: var(--radius-sm);

      &:hover {
        color: var(--text-primary);
        background: var(--bg-hover);
      }
    }

    .search-options {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-wrap: wrap;
    }

    .option-toggle {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      cursor: pointer;
      user-select: none;

      input[type="checkbox"] {
        width: 14px;
        height: 14px;
        accent-color: var(--primary-color);
        cursor: pointer;
      }

      .toggle-label {
        font-size: 12px;
        color: var(--text-secondary);
      }

      &:hover .toggle-label {
        color: var(--text-primary);
      }
    }

    .file-pattern {
      flex: 1;
      min-width: 120px;
    }

    .pattern-input {
      width: 100%;
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        border-color: var(--primary-color);
        outline: none;
      }

      &:disabled {
        opacity: 0.5;
      }
    }

    .result-count {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .count-label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .count-select {
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
      cursor: pointer;

      &:focus {
        border-color: var(--primary-color);
        outline: none;
      }

      &:disabled {
        opacity: 0.5;
      }
    }

    .searching-indicator {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 12px;
      color: var(--text-muted);
    }

    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-color);
      border-top-color: var(--primary-color);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border-width: 0;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodebaseSearchComponent {
  /** Store ID for search */
  storeId = input.required<string>();

  /** Whether the search is disabled */
  disabled = input<boolean>(false);

  /** Whether a search is in progress */
  isSearching = input<boolean>(false);

  /** Emits search options when user triggers search */
  searchTriggered = output<HybridSearchOptions>();

  // Local state
  searchQuery = signal('');
  useHyDE = signal(true);
  filePattern = signal('');
  topK = signal(25);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Cleanup on destroy is handled by Angular
  }

  onQueryChange(value: string): void {
    this.searchQuery.set(value);
    this.debouncedSearch();
  }

  onPatternChange(value: string): void {
    this.filePattern.set(value);
    this.debouncedSearch();
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.triggerSearch();
  }

  triggerSearch(): void {
    const query = this.searchQuery().trim();
    if (!query) return;

    const options: HybridSearchOptions = {
      query,
      storeId: this.storeId(),
      topK: this.topK(),
      useHyDE: this.useHyDE(),
    };

    // Parse file patterns
    const patterns = this.filePattern()
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (patterns.length > 0) {
      options.filePatterns = patterns;
    }

    this.searchTriggered.emit(options);
  }

  private debouncedSearch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.triggerSearch();
    }, 300);
  }
}
