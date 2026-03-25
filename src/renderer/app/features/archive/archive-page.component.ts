/**
 * Archive Page
 * Container for viewing, searching, restoring, and deleting session archives.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ArchiveIpcService } from '../../core/services/ipc/archive-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface ArchiveEntry {
  id: string;
  sessionId: string;
  createdAt: number;
  tags: string[];
  notes?: string;
  messageCount?: number;
}

@Component({
  selector: 'app-archive-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">

      <!-- Page header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Archives</span>
          <span class="subtitle">Session archive management and search</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refresh()">
            Refresh
          </button>
        </div>
      </div>

      <!-- Error / info banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Metric cards -->
      <div class="metrics">
        <div class="metric-card">
          <span class="metric-value">{{ archives().length }}</span>
          <span class="metric-label">Total Archives</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ uniqueTagCount() }}</span>
          <span class="metric-label">Total Tags</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ dateRangeLabel() }}</span>
          <span class="metric-label">Date Range</span>
        </div>
      </div>

      <!-- Search and filter bar -->
      <div class="filter-bar">
        <div class="search-field">
          <input
            class="input"
            type="text"
            placeholder="Search archives..."
            [value]="searchQuery()"
            (input)="onSearchInput($event)"
          />
        </div>

        <div class="tag-filters">
          @if (allTags().length > 0) {
            <span class="filter-label">Tags:</span>
            @for (tag of allTags(); track tag) {
              <button
                class="tag-chip"
                type="button"
                [class.active]="activeTagFilters().includes(tag)"
                (click)="toggleTagFilter(tag)"
              >{{ tag }}</button>
            }
          }
        </div>

        <div class="date-range">
          <label class="date-field">
            <span class="date-label">From</span>
            <input
              class="input input-date"
              type="date"
              [value]="startDateValue()"
              (change)="onStartDateChange($event)"
            />
          </label>
          <label class="date-field">
            <span class="date-label">To</span>
            <input
              class="input input-date"
              type="date"
              [value]="endDateValue()"
              (change)="onEndDateChange($event)"
            />
          </label>
        </div>
      </div>

      <!-- Archive list -->
      <div class="archive-list">
        @if (working() && archives().length === 0) {
          <div class="empty-state">Loading archives...</div>
        } @else if (filteredArchives().length === 0) {
          <div class="empty-state">No archives found.</div>
        } @else {
          @for (entry of filteredArchives(); track entry.id) {
            <div
              class="archive-card"
              [class.selected]="selectedEntry()?.id === entry.id"
              role="button"
              tabindex="0"
              (click)="selectEntry(entry)"
              (keydown.enter)="selectEntry(entry)"
            >
              <div class="card-header">
                <span class="session-id">{{ entry.sessionId }}</span>
                <span class="card-date">{{ formatDate(entry.createdAt) }}</span>
              </div>

              @if (entry.tags.length > 0) {
                <div class="card-tags">
                  @for (tag of entry.tags; track tag) {
                    <span class="tag-chip small">{{ tag }}</span>
                  }
                </div>
              }

              @if (entry.notes) {
                <div class="card-notes">{{ truncateNotes(entry.notes) }}</div>
              }

              @if (entry.messageCount !== undefined) {
                <div class="card-meta">{{ entry.messageCount }} messages</div>
              }

              <div class="card-actions">
                <button
                  class="btn btn-sm"
                  type="button"
                  [disabled]="working()"
                  (click)="restoreEntry($event, entry)"
                >
                  Restore
                </button>
                <button
                  class="btn btn-sm btn-danger"
                  type="button"
                  [disabled]="working()"
                  (click)="deleteEntry($event, entry)"
                >
                  Delete
                </button>
              </div>
            </div>
          }
        }
      </div>

      <!-- Archive detail drawer -->
      @if (selectedEntry()) {
        <div class="drawer-overlay" role="presentation" (click)="closeDrawer()" (keydown.escape)="closeDrawer()"></div>
        <div class="drawer">
          <div class="drawer-header">
            <span class="drawer-title">Archive Detail</span>
            <button class="drawer-close" type="button" (click)="closeDrawer()">✕</button>
          </div>

          <div class="drawer-body">
            <div class="detail-row">
              <span class="detail-label">Session ID</span>
              <span class="detail-value mono">{{ selectedEntry()!.sessionId }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Archive ID</span>
              <span class="detail-value mono">{{ selectedEntry()!.id }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">Created</span>
              <span class="detail-value">{{ formatDate(selectedEntry()!.createdAt) }}</span>
            </div>
            @if (selectedEntry()!.messageCount !== undefined) {
              <div class="detail-row">
                <span class="detail-label">Messages</span>
                <span class="detail-value">{{ selectedEntry()!.messageCount }}</span>
              </div>
            }

            <!-- Notes -->
            @if (selectedEntry()!.notes) {
              <div class="detail-section">
                <span class="detail-label">Notes</span>
                <p class="detail-notes">{{ selectedEntry()!.notes }}</p>
              </div>
            }

            <!-- Tags editor -->
            <div class="detail-section">
              <span class="detail-label">Tags</span>
              <div class="tag-editor">
                @if (selectedEntry()!.tags.length > 0) {
                  <div class="tag-list">
                    @for (tag of selectedEntry()!.tags; track tag) {
                      <span class="tag-chip">
                        {{ tag }}
                        <button
                          class="tag-remove"
                          type="button"
                          (click)="removeTag(tag)"
                        >×</button>
                      </span>
                    }
                  </div>
                } @else {
                  <span class="hint">No tags.</span>
                }
                <div class="tag-add-row">
                  <input
                    class="input input-sm"
                    type="text"
                    placeholder="Add tag..."
                    [value]="newTagInput()"
                    (input)="onNewTagInput($event)"
                    (keydown.enter)="addTag()"
                  />
                  <button
                    class="btn btn-sm"
                    type="button"
                    [disabled]="!newTagInput().trim()"
                    (click)="addTag()"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="drawer-footer">
            <button
              class="btn btn-primary"
              type="button"
              [disabled]="working()"
              (click)="restoreEntry($event, selectedEntry()!)"
            >
              Restore
            </button>
            <button
              class="btn btn-danger"
              type="button"
              [disabled]="working()"
              (click)="deleteEntry($event, selectedEntry()!)"
            >
              Delete
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
        position: relative;
      }

      .page {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
        overflow: auto;
      }

      /* ---- Header ---- */

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .header-title {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      /* ---- Banners ---- */

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
        flex-shrink: 0;
      }

      .error-banner {
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .info-banner {
        border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        color: var(--text-primary);
      }

      /* ---- Metrics ---- */

      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .metric-card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: var(--spacing-md);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }

      .metric-value {
        font-size: 22px;
        font-weight: 700;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .metric-label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      /* ---- Filter bar ---- */

      .filter-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        flex-shrink: 0;
      }

      .search-field {
        flex: 1 1 200px;
        min-width: 0;
      }

      .tag-filters {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .filter-label {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }

      .date-range {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
      }

      .date-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .date-label {
        font-size: 10px;
        color: var(--text-muted);
      }

      /* ---- Inputs / buttons ---- */

      .input {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .input-date {
        width: auto;
      }

      .input-sm {
        padding: 2px var(--spacing-sm);
        font-size: 11px;
      }

      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .btn-sm {
        padding: 2px 8px;
        font-size: 11px;
      }

      .btn-primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn-danger {
        background: var(--error-color);
        border-color: var(--error-color);
        color: #fff;
      }

      .header-btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }

      /* ---- Tag chips ---- */

      .tag-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 11px;
        cursor: pointer;
        white-space: nowrap;
      }

      .tag-chip.active {
        border-color: var(--primary-color);
        background: color-mix(in srgb, var(--primary-color) 18%, transparent);
        color: var(--text-primary);
      }

      .tag-chip.small {
        font-size: 10px;
        padding: 1px 6px;
        cursor: default;
      }

      .tag-remove {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--text-muted);
        padding: 0;
        font-size: 13px;
        line-height: 1;
      }

      /* ---- Archive list ---- */

      .archive-list {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        overflow: auto;
      }

      .empty-state {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--text-muted);
        font-size: 13px;
      }

      .archive-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-sm) var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        cursor: pointer;
        transition: border-color 0.1s;
      }

      .archive-card:hover {
        border-color: color-mix(in srgb, var(--primary-color) 50%, transparent);
      }

      .archive-card.selected {
        border-color: var(--primary-color);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 30%, transparent);
      }

      .card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .session-id {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
        font-family: var(--font-family-mono, monospace);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .card-date {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .card-tags {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .card-notes {
        font-size: 12px;
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .card-meta {
        font-size: 11px;
        color: var(--text-muted);
      }

      .card-actions {
        display: flex;
        gap: var(--spacing-xs);
        margin-top: 2px;
      }

      /* ---- Drawer ---- */

      .drawer-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 100;
      }

      .drawer {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: 360px;
        max-width: 90vw;
        background: var(--bg-primary);
        border-left: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        z-index: 101;
        overflow: hidden;
      }

      .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md) var(--spacing-lg);
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
      }

      .drawer-title {
        font-size: 14px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .drawer-close {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--text-muted);
        font-size: 16px;
        padding: 2px;
        line-height: 1;
      }

      .drawer-body {
        flex: 1;
        overflow: auto;
        padding: var(--spacing-lg);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .drawer-footer {
        display: flex;
        gap: var(--spacing-sm);
        padding: var(--spacing-md) var(--spacing-lg);
        border-top: 1px solid var(--border-color);
        flex-shrink: 0;
      }

      /* ---- Detail rows ---- */

      .detail-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .detail-section {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .detail-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }

      .detail-value {
        font-size: 12px;
        color: var(--text-primary);
        word-break: break-all;
      }

      .detail-value.mono {
        font-family: var(--font-family-mono, monospace);
      }

      .detail-notes {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* ---- Tag editor ---- */

      .tag-editor {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .tag-list {
        display: flex;
        flex-wrap: wrap;
        gap: var(--spacing-xs);
      }

      .tag-add-row {
        display: flex;
        gap: var(--spacing-xs);
      }

      .tag-add-row .input-sm {
        flex: 1;
        min-width: 0;
      }

      .hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 700px) {
        .metrics {
          grid-template-columns: 1fr;
        }

        .drawer {
          width: 100%;
          max-width: 100vw;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArchivePageComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly archiveIpc = inject(ArchiveIpcService);

  readonly archives = signal<ArchiveEntry[]>([]);
  readonly selectedEntry = signal<ArchiveEntry | null>(null);

  readonly searchQuery = signal('');
  readonly activeTagFilters = signal<string[]>([]);
  readonly startDateValue = signal('');
  readonly endDateValue = signal('');
  readonly newTagInput = signal('');

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly allTags = computed<string[]>(() => {
    const tagSet = new Set<string>();
    for (const entry of this.archives()) {
      for (const tag of entry.tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  });

  readonly uniqueTagCount = computed(() => this.allTags().length);

  readonly dateRangeLabel = computed<string>(() => {
    const entries = this.archives();
    if (entries.length === 0) {
      return '—';
    }
    const timestamps = entries.map((e) => e.createdAt);
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return `${fmt(minDate)} – ${fmt(maxDate)}`;
  });

  readonly filteredArchives = computed<ArchiveEntry[]>(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const tags = this.activeTagFilters();
    const start = this.startDateValue() ? new Date(this.startDateValue()).getTime() : null;
    const end = this.endDateValue()
      ? new Date(this.endDateValue()).getTime() + 86_400_000 - 1
      : null;

    return this.archives().filter((entry) => {
      if (query) {
        const inSession = entry.sessionId.toLowerCase().includes(query);
        const inNotes = entry.notes?.toLowerCase().includes(query) ?? false;
        const inTags = entry.tags.some((t) => t.toLowerCase().includes(query));
        if (!inSession && !inNotes && !inTags) {
          return false;
        }
      }
      if (tags.length > 0 && !tags.every((t) => entry.tags.includes(t))) {
        return false;
      }
      if (start !== null && entry.createdAt < start) {
        return false;
      }
      if (end !== null && entry.createdAt > end) {
        return false;
      }
      return true;
    });
  });

  async ngOnInit(): Promise<void> {
    await this.loadArchives();
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  async refresh(): Promise<void> {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    await this.loadArchives();
  }

  selectEntry(entry: ArchiveEntry): void {
    this.selectedEntry.set(entry);
    this.newTagInput.set('');
  }

  closeDrawer(): void {
    this.selectedEntry.set(null);
    this.newTagInput.set('');
  }

  async restoreEntry(event: Event, entry: ArchiveEntry): Promise<void> {
    event.stopPropagation();
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response = await this.archiveIpc.archiveRestore(entry.id);
      this.assertSuccess(response, 'Failed to restore archive.');
      this.infoMessage.set(`Session "${entry.sessionId}" restored.`);
      this.closeDrawer();
      await this.loadArchives();
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  async deleteEntry(event: Event, entry: ArchiveEntry): Promise<void> {
    event.stopPropagation();
    if (!confirm(`Delete archive for session "${entry.sessionId}"? This cannot be undone.`)) {
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response = await this.archiveIpc.archiveDelete(entry.id);
      this.assertSuccess(response, 'Failed to delete archive.');
      this.infoMessage.set('Archive deleted.');

      if (this.selectedEntry()?.id === entry.id) {
        this.closeDrawer();
      }
      await this.loadArchives();
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  toggleTagFilter(tag: string): void {
    const current = this.activeTagFilters();
    if (current.includes(tag)) {
      this.activeTagFilters.set(current.filter((t) => t !== tag));
    } else {
      this.activeTagFilters.set([...current, tag]);
    }
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.searchQuery.set(target.value);

    if (this.searchDebounceTimer !== null) {
      clearTimeout(this.searchDebounceTimer);
    }

    const query = target.value.trim();
    if (query.length >= 2) {
      this.searchDebounceTimer = setTimeout(() => {
        void this.runSearch(query);
      }, 350);
    }
  }

  onStartDateChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.startDateValue.set(target.value);
  }

  onEndDateChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.endDateValue.set(target.value);
  }

  onNewTagInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.newTagInput.set(target.value);
  }

  addTag(): void {
    const tag = this.newTagInput().trim();
    if (!tag) {
      return;
    }

    const entry = this.selectedEntry();
    if (!entry) {
      return;
    }

    if (!entry.tags.includes(tag)) {
      const updated: ArchiveEntry = { ...entry, tags: [...entry.tags, tag] };
      this.selectedEntry.set(updated);
      this.archives.update((list) =>
        list.map((a) => (a.id === updated.id ? updated : a))
      );
    }

    this.newTagInput.set('');
  }

  removeTag(tag: string): void {
    const entry = this.selectedEntry();
    if (!entry) {
      return;
    }

    const updated: ArchiveEntry = {
      ...entry,
      tags: entry.tags.filter((t) => t !== tag),
    };
    this.selectedEntry.set(updated);
    this.archives.update((list) =>
      list.map((a) => (a.id === updated.id ? updated : a))
    );
  }

  formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  truncateNotes(notes: string, maxLength = 80): string {
    if (notes.length <= maxLength) {
      return notes;
    }
    return notes.slice(0, maxLength) + '…';
  }

  private async loadArchives(): Promise<void> {
    this.working.set(true);

    try {
      const response = await this.archiveIpc.archiveList();
      this.assertSuccess(response, 'Failed to load archives.');
      const entries = this.extractData<ArchiveEntry[]>(response) ?? [];
      this.archives.set(entries);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  private async runSearch(query: string): Promise<void> {
    this.working.set(true);

    try {
      const response = await this.archiveIpc.archiveSearch(query);
      this.assertSuccess(response, 'Failed to search archives.');
      const entries = this.extractData<ArchiveEntry[]>(response) ?? [];
      this.archives.set(entries);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  private assertSuccess(response: IpcResponse, fallback: string): void {
    if (!response.success) {
      throw new Error(response.error?.message || fallback);
    }
  }

  private extractData<T>(response: IpcResponse): T | null {
    return response.success ? (response.data as T) : null;
  }
}
