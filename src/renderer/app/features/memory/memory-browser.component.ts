/**
 * Memory Browser Component
 *
 * Browse and manage stored memories:
 * - Entry content display
 * - Relevance and confidence scores
 * - Access count tracking
 * - Links visualization
 * - Search/filter by tags
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { SlicePipe } from '@angular/common';
import type { MemoryEntry } from '../../../../shared/types/memory-r1.types';
import type { MemoryType } from '../../../../shared/types/unified-memory.types';

/** Extended memory entry with type classification for UI display */
interface MemoryEntryWithType extends MemoryEntry {
  type?: MemoryType;
}

@Component({
  selector: 'app-memory-browser',
  standalone: true,
  imports: [SlicePipe],
  template: `
    <div class="memory-container">
      <!-- Header -->
      <div class="memory-header">
        <div class="header-left">
          <span class="memory-icon">🧠</span>
          <span class="memory-title">Memory Store</span>
          <span class="memory-count">{{ entries().length }} entries</span>
        </div>
        <div class="header-actions">
          <input
            type="text"
            class="search-input"
            placeholder="Search memories..."
            [value]="searchQuery()"
            (input)="onSearch($event)"
          />
        </div>
      </div>

      <!-- Filters -->
      <div class="filters-section">
        <button
          class="filter-btn"
          [class.active]="typeFilter() === ''"
          (click)="setTypeFilter('')"
        >
          All
        </button>
        @for (type of memoryTypes; track type) {
          <button
            class="filter-btn"
            [class.active]="typeFilter() === type"
            (click)="setTypeFilter(type)"
          >
            {{ type }}
          </button>
        }

        <div class="filter-spacer"></div>

        <label class="sort-label">Sort:</label>
        <select
          class="sort-select"
          [value]="sortBy()"
          (change)="onSortChange($event)"
        >
          <option value="relevance">Relevance</option>
          <option value="accessCount">Access Count</option>
          <option value="createdAt">Recent</option>
          <option value="confidence">Confidence</option>
        </select>
      </div>

      <!-- Tags -->
      @if (availableTags().length > 0) {
        <div class="tags-section">
          <span class="tags-label">Tags:</span>
          <div class="tags-list">
            @for (tag of availableTags() | slice:0:10; track tag) {
              <button
                class="tag-btn"
                [class.active]="selectedTags().has(tag)"
                (click)="toggleTag(tag)"
              >
                {{ tag }}
              </button>
            }
            @if (availableTags().length > 10) {
              <span class="tags-more">+{{ availableTags().length - 10 }} more</span>
            }
          </div>
        </div>
      }

      <!-- Entries List -->
      <div class="entries-list">
        @for (entry of filteredEntries(); track entry.id) {
          <div
            class="entry-card"
            [class.selected]="selectedEntry()?.id === entry.id"
            (click)="selectEntry(entry)"
          >
            <!-- Entry Header -->
            <div class="entry-header">
              @if (entry.type) {
                <span class="entry-type" [class]="'type-' + entry.type">
                  {{ getTypeIcon(entry.type) }} {{ entry.type }}
                </span>
              } @else {
                <span class="entry-type type-unknown">
                  📝 memory
                </span>
              }
              <div class="entry-scores">
                @if (entry.relevanceScore !== undefined) {
                  <span class="score relevance" title="Relevance">
                    R: {{ (entry.relevanceScore * 100).toFixed(0) }}%
                  </span>
                }
                @if (entry.confidenceScore !== undefined) {
                  <span class="score confidence" title="Confidence">
                    C: {{ (entry.confidenceScore * 100).toFixed(0) }}%
                  </span>
                }
                @if (entry.accessCount) {
                  <span class="score access" title="Access count">
                    👁 {{ entry.accessCount }}
                  </span>
                }
              </div>
            </div>

            <!-- Entry Content Preview -->
            <div class="entry-content">
              {{ truncateContent(entry.content) }}
            </div>

            <!-- Entry Tags -->
            @if (entry.tags && entry.tags.length > 0) {
              <div class="entry-tags">
                @for (tag of entry.tags | slice:0:5; track tag) {
                  <span class="entry-tag">{{ tag }}</span>
                }
              </div>
            }

            <!-- Entry Meta -->
            <div class="entry-meta">
              <span class="meta-item">
                {{ formatTime(entry.createdAt) }}
              </span>
              @if (entry.linkedEntries && entry.linkedEntries.length > 0) {
                <span class="meta-item links">
                  🔗 {{ entry.linkedEntries.length }} links
                </span>
              }
            </div>
          </div>
        }

        @if (filteredEntries().length === 0) {
          <div class="empty-state">
            @if (entries().length === 0) {
              <span class="empty-icon">🧠</span>
              <span class="empty-text">No memories stored yet</span>
            } @else {
              <span class="empty-icon">🔍</span>
              <span class="empty-text">No memories match your filters</span>
            }
          </div>
        }
      </div>

      <!-- Selected Entry Details -->
      @if (selectedEntry(); as entry) {
        <div class="entry-details">
          <div class="details-header">
            @if (entry.type) {
              <span class="details-type" [class]="'type-' + entry.type">
                {{ getTypeIcon(entry.type) }} {{ entry.type }}
              </span>
            } @else {
              <span class="details-type type-unknown">
                📝 memory
              </span>
            }
            <button class="close-btn" (click)="clearSelection()">✕</button>
          </div>

          <div class="details-body">
            <!-- Full Content -->
            <div class="details-section">
              <span class="section-label">Content</span>
              <pre class="full-content">{{ entry.content }}</pre>
            </div>

            <!-- Scores -->
            <div class="details-section">
              <span class="section-label">Scores</span>
              <div class="scores-grid">
                @if (entry.relevanceScore !== undefined) {
                  <div class="score-item">
                    <span class="score-label">Relevance</span>
                    <div class="score-bar">
                      <div
                        class="score-fill relevance"
                        [style.width.%]="entry.relevanceScore * 100"
                      ></div>
                    </div>
                    <span class="score-value">{{ (entry.relevanceScore * 100).toFixed(0) }}%</span>
                  </div>
                }
                @if (entry.confidenceScore !== undefined) {
                  <div class="score-item">
                    <span class="score-label">Confidence</span>
                    <div class="score-bar">
                      <div
                        class="score-fill confidence"
                        [style.width.%]="entry.confidenceScore * 100"
                      ></div>
                    </div>
                    <span class="score-value">{{ (entry.confidenceScore * 100).toFixed(0) }}%</span>
                  </div>
                }
              </div>
            </div>

            <!-- Tags -->
            @if (entry.tags && entry.tags.length > 0) {
              <div class="details-section">
                <span class="section-label">Tags</span>
                <div class="details-tags">
                  @for (tag of entry.tags; track tag) {
                    <span class="detail-tag">{{ tag }}</span>
                  }
                </div>
              </div>
            }

            <!-- Links -->
            @if (entry.linkedEntries && entry.linkedEntries.length > 0) {
              <div class="details-section">
                <span class="section-label">Linked Memories</span>
                <div class="links-list">
                  @for (linkId of entry.linkedEntries; track linkId) {
                    <button
                      class="link-item"
                      (click)="navigateToLink(linkId)"
                    >
                      🔗 {{ linkId | slice:0:8 }}...
                    </button>
                  }
                </div>
              </div>
            }

            <!-- Metadata -->
            <div class="details-section">
              <span class="section-label">Metadata</span>
              <div class="metadata-grid">
                <div class="metadata-item">
                  <span class="metadata-label">Created</span>
                  <span class="metadata-value">{{ formatFullTime(entry.createdAt) }}</span>
                </div>
                @if (entry.accessCount) {
                  <div class="metadata-item">
                    <span class="metadata-label">Access Count</span>
                    <span class="metadata-value">{{ entry.accessCount }}</span>
                  </div>
                }
                @if (entry.lastAccessedAt) {
                  <div class="metadata-item">
                    <span class="metadata-label">Last Accessed</span>
                    <span class="metadata-value">{{ formatFullTime(entry.lastAccessedAt) }}</span>
                  </div>
                }
              </div>
            </div>
          </div>

          <div class="details-actions">
            <button class="action-btn danger" (click)="deleteEntry(entry)">
              Delete
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .memory-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
      max-height: 600px;
    }

    .memory-header {
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

    .memory-icon {
      font-size: 18px;
    }

    .memory-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .memory-count {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .search-input {
      padding: 6px 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      width: 200px;

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }
    }

    .filters-section {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .filter-btn {
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .filter-spacer {
      flex: 1;
    }

    .sort-label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .sort-select {
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 11px;
    }

    .tags-section {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      overflow-x: auto;
    }

    .tags-label {
      font-size: 11px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .tags-list {
      display: flex;
      gap: 4px;
    }

    .tag-btn {
      padding: 2px 8px;
      background: var(--bg-tertiary);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 10px;
      cursor: pointer;
      white-space: nowrap;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--border-color);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .tags-more {
      font-size: 10px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .entries-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .entry-card {
      background: var(--bg-tertiary);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      padding: var(--spacing-sm);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        border-color: var(--border-color);
      }

      &.selected {
        border-color: var(--primary-color);
        background: var(--bg-secondary);
      }
    }

    .entry-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--spacing-xs);
    }

    .entry-type {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;

      &.type-episodic {
        background: rgba(59, 130, 246, 0.2);
        color: #3b82f6;
      }

      &.type-procedural {
        background: rgba(16, 185, 129, 0.2);
        color: #10b981;
      }

      &.type-semantic {
        background: rgba(245, 158, 11, 0.2);
        color: #f59e0b;
      }

      &.type-short_term {
        background: rgba(139, 92, 246, 0.2);
        color: #8b5cf6;
      }

      &.type-long_term {
        background: rgba(236, 72, 153, 0.2);
        color: #ec4899;
      }

      &.type-unknown {
        background: rgba(107, 114, 128, 0.2);
        color: #6b7280;
      }
    }

    .entry-scores {
      display: flex;
      gap: var(--spacing-xs);
    }

    .score {
      font-size: 9px;
      color: var(--text-muted);

      &.relevance { color: #3b82f6; }
      &.confidence { color: #10b981; }
      &.access { color: var(--text-secondary); }
    }

    .entry-content {
      font-size: 12px;
      color: var(--text-primary);
      line-height: 1.4;
      margin-bottom: var(--spacing-xs);
    }

    .entry-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: var(--spacing-xs);
    }

    .entry-tag {
      padding: 1px 4px;
      background: var(--bg-secondary);
      border-radius: 2px;
      font-size: 9px;
      color: var(--text-muted);
    }

    .entry-meta {
      display: flex;
      gap: var(--spacing-sm);
    }

    .meta-item {
      font-size: 10px;
      color: var(--text-muted);

      &.links {
        color: var(--primary-color);
      }
    }

    /* Entry Details */
    .entry-details {
      border-top: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      max-height: 300px;
      overflow-y: auto;
    }

    .details-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .details-type {
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 600;
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

    .details-body {
      padding: var(--spacing-md);
    }

    .details-section {
      margin-bottom: var(--spacing-md);

      &:last-child {
        margin-bottom: 0;
      }
    }

    .section-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: var(--spacing-xs);
    }

    .full-content {
      margin: 0;
      padding: var(--spacing-sm);
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 12px;
      color: var(--text-primary);
      white-space: pre-wrap;
      max-height: 100px;
      overflow-y: auto;
    }

    .scores-grid {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .score-item {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .score-label {
      width: 70px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .score-bar {
      flex: 1;
      height: 6px;
      background: var(--bg-secondary);
      border-radius: 3px;
      overflow: hidden;
    }

    .score-fill {
      height: 100%;
      border-radius: 3px;

      &.relevance {
        background: #3b82f6;
      }

      &.confidence {
        background: #10b981;
      }
    }

    .score-value {
      width: 40px;
      font-size: 11px;
      color: var(--text-secondary);
      text-align: right;
    }

    .details-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .detail-tag {
      padding: 2px 6px;
      background: var(--bg-secondary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .links-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .link-item {
      padding: 4px 8px;
      background: var(--bg-secondary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--primary-color);
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--primary-color);
        color: white;
      }
    }

    .metadata-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--spacing-sm);
    }

    .metadata-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metadata-label {
      font-size: 10px;
      color: var(--text-muted);
    }

    .metadata-value {
      font-size: 12px;
      color: var(--text-primary);
    }

    .details-actions {
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: flex-end;
    }

    .action-btn {
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

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
      font-size: 13px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MemoryBrowserComponent {
  /** Memory entries */
  entries = input<MemoryEntryWithType[]>([]);

  /** Events */
  entrySelected = output<MemoryEntryWithType>();
  entryDeleted = output<string>();
  navigateToEntry = output<string>();

  /** Memory types (from unified-memory.types.ts) */
  memoryTypes: MemoryType[] = ['short_term', 'long_term', 'episodic', 'semantic', 'procedural'];

  /** Search query */
  searchQuery = signal('');

  /** Type filter */
  typeFilter = signal<MemoryType | ''>('');

  /** Sort by */
  sortBy = signal<'relevance' | 'accessCount' | 'createdAt' | 'confidence'>('relevance');

  /** Selected tags */
  selectedTags = signal(new Set<string>());

  /** Selected entry */
  selectedEntry = signal<MemoryEntryWithType | null>(null);

  /** Available tags */
  availableTags = computed(() => {
    const tags = new Set<string>();
    for (const entry of this.entries()) {
      if (entry.tags) {
        for (const tag of entry.tags) {
          tags.add(tag);
        }
      }
    }
    return Array.from(tags).sort();
  });

  /** Filtered and sorted entries */
  filteredEntries = computed(() => {
    const query = this.searchQuery().toLowerCase();
    const type = this.typeFilter();
    const tags = this.selectedTags();
    const sort = this.sortBy();

    let filtered = this.entries().filter((entry) => {
      if (type && entry.type !== type) return false;
      if (query && !entry.content.toLowerCase().includes(query)) return false;
      if (tags.size > 0) {
        if (!entry.tags || !entry.tags.some((t) => tags.has(t))) return false;
      }
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      switch (sort) {
        case 'relevance':
          return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
        case 'accessCount':
          return (b.accessCount ?? 0) - (a.accessCount ?? 0);
        case 'createdAt':
          return b.createdAt - a.createdAt;
        case 'confidence':
          return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0);
        default:
          return 0;
      }
    });

    return filtered;
  });

  getTypeIcon(type: MemoryType): string {
    switch (type) {
      case 'episodic':
        return '📅';
      case 'procedural':
        return '⚙️';
      case 'semantic':
        return '💡';
      case 'short_term':
        return '💭';
      case 'long_term':
        return '🗄️';
      default:
        return '📝';
    }
  }

  truncateContent(content: string): string {
    if (content.length <= 150) return content;
    return content.slice(0, 150) + '...';
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

  formatFullTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }

  onSearch(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.searchQuery.set(target.value);
  }

  setTypeFilter(type: MemoryType | ''): void {
    this.typeFilter.set(type);
  }

  onSortChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.sortBy.set(target.value as typeof this.sortBy extends () => infer T ? T : never);
  }

  toggleTag(tag: string): void {
    this.selectedTags.update((tags) => {
      const newTags = new Set(tags);
      if (newTags.has(tag)) {
        newTags.delete(tag);
      } else {
        newTags.add(tag);
      }
      return newTags;
    });
  }

  selectEntry(entry: MemoryEntryWithType): void {
    this.selectedEntry.set(entry);
    this.entrySelected.emit(entry);
  }

  clearSelection(): void {
    this.selectedEntry.set(null);
  }

  deleteEntry(entry: MemoryEntryWithType): void {
    this.entryDeleted.emit(entry.id);
    this.clearSelection();
  }

  navigateToLink(linkId: string): void {
    this.navigateToEntry.emit(linkId);
    const linked = this.entries().find((e) => e.id === linkId);
    if (linked) {
      this.selectEntry(linked);
    }
  }
}
