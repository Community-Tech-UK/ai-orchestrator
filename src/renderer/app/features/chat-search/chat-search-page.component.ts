import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

interface SearchResult {
  kind: 'session' | 'live';
  id: string;
  title: string;
  subtitle: string;
  workingDirectory: string;
  snippet: string;
  timestamp: number;
}

const SNIPPET_MAX = 140;
const RESULT_CAP = 50;

@Component({
  selector: 'app-chat-search-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="search-page">
      <header class="search-header">
        <button class="back-btn" type="button" (click)="goBack()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          Back
        </button>
        <div class="search-input-wrap">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.3-4.3"></path>
          </svg>
          <input
            #searchInput
            type="text"
            class="search-input"
            placeholder="Search projects, sessions, and messages…"
            [value]="query()"
            (input)="onQueryChange($event)"
            aria-label="Search query"
          />
          @if (query()) {
            <button
              type="button"
              class="clear-btn"
              (click)="clear()"
              aria-label="Clear search"
              title="Clear"
            >
              ×
            </button>
          }
        </div>
      </header>

      <section class="search-meta">
        @if (loading()) {
          <span>Loading…</span>
        } @else if (query().trim().length === 0) {
          <span>{{ totalSearchable() }} sessions ready to search</span>
        } @else {
          <span>{{ results().length }} {{ results().length === 1 ? 'match' : 'matches' }}{{ truncated() ? ' (showing first ' + RESULT_CAP + ')' : '' }}</span>
        }
      </section>

      <section class="results">
        @if (results().length === 0 && query().trim().length > 0 && !loading()) {
          <div class="empty">
            <p>No matches for "{{ query() }}"</p>
            <p class="hint">Search runs across session titles, the first and last message of each session, and project paths.</p>
          </div>
        } @else {
          @for (result of results(); track result.id) {
            <button
              type="button"
              class="result-row"
              [attr.aria-label]="'Open ' + result.title"
              (click)="open(result)"
            >
              <div class="result-line-1">
                <span class="result-kind" [class.live]="result.kind === 'live'">
                  {{ result.kind === 'live' ? 'Live' : 'Session' }}
                </span>
                <span class="result-title">{{ result.title }}</span>
                <span class="result-time">{{ formatTime(result.timestamp) }}</span>
              </div>
              @if (result.subtitle) {
                <div class="result-subtitle">{{ result.subtitle }}</div>
              }
              @if (result.snippet) {
                <div class="result-snippet">{{ result.snippet }}</div>
              }
            </button>
          }
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .search-page {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 28px 32px;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
    }

    .search-header {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 8px;
      background: var(--glass-light);
      border: 1px solid var(--glass-border);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 12px;
      transition: all var(--transition-fast);

      &:hover {
        color: var(--text-primary);
        background: var(--glass-strong);
      }
    }

    .search-input-wrap {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-icon {
      position: absolute;
      left: 14px;
      color: var(--text-muted);
      pointer-events: none;
    }

    .search-input {
      flex: 1;
      width: 100%;
      padding: 12px 40px;
      border-radius: 12px;
      border: 1px solid var(--glass-border);
      background: var(--glass-light);
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;

      &::placeholder { color: var(--text-muted); }

      &:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
      }
    }

    .clear-btn {
      position: absolute;
      right: 8px;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--glass-strong);
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;

      &:hover { color: var(--text-primary); }
    }

    .search-meta {
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      padding: 0 4px;
    }

    .results {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0 -8px;
      padding: 0 8px 16px;
    }

    .empty {
      padding: 32px 16px;
      text-align: center;
      color: var(--text-muted);

      .hint {
        margin-top: 8px;
        font-size: 12px;
        opacity: 0.7;
      }
    }

    .result-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 14px;
      border-radius: 10px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-primary);
      text-align: left;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--glass-light);
        border-color: var(--glass-border);
      }
    }

    .result-line-1 {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    .result-kind {
      flex-shrink: 0;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--glass-light);
      border: 1px solid var(--glass-border);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .result-kind.live {
      color: var(--primary-color);
      border-color: rgba(var(--primary-rgb), 0.32);
      background: rgba(var(--primary-rgb), 0.1);
    }

    .result-title {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 14px;
      color: var(--text-primary);
    }

    .result-time {
      flex-shrink: 0;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .result-subtitle {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .result-snippet {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.45;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  `],
})
export class ChatSearchPageComponent implements OnInit, AfterViewInit {
  private historyStore = inject(HistoryStore);
  private instanceStore = inject(InstanceStore);
  private router = inject(Router);

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  protected readonly RESULT_CAP = RESULT_CAP;

  query = signal('');
  loading = computed(() => this.historyStore.loading());

  totalSearchable = computed(() =>
    this.historyStore.entries().length + this.instanceStore.instances().length
  );

  private allResults = computed<SearchResult[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];

    const matches: SearchResult[] = [];

    for (const entry of this.historyStore.entries()) {
      if (entry.archivedAt) continue;
      if (this.entryMatches(entry, q)) {
        matches.push(this.entryToResult(entry));
      }
    }

    for (const inst of this.instanceStore.instances()) {
      const title = (inst.displayName ?? '').toString();
      const wd = (inst.workingDirectory ?? '').toString();
      if (
        title.toLowerCase().includes(q)
        || wd.toLowerCase().includes(q)
      ) {
        matches.push({
          kind: 'live',
          id: 'live:' + inst.id,
          title: title || 'Untitled session',
          subtitle: wd,
          workingDirectory: wd,
          snippet: '',
          timestamp: inst.lastActivity ?? inst.createdAt ?? 0,
        });
      }
    }

    matches.sort((a, b) => b.timestamp - a.timestamp);
    return matches;
  });

  results = computed(() => this.allResults().slice(0, RESULT_CAP));
  truncated = computed(() => this.allResults().length > RESULT_CAP);

  ngOnInit(): void {
    if (this.historyStore.entries().length === 0 && !this.historyStore.loading()) {
      void this.historyStore.loadHistory();
    }
  }

  ngAfterViewInit(): void {
    this.searchInput?.nativeElement.focus();
  }

  onQueryChange(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  clear(): void {
    this.query.set('');
    this.searchInput?.nativeElement.focus();
  }

  async open(result: SearchResult): Promise<void> {
    if (result.kind === 'live') {
      const liveId = result.id.replace(/^live:/, '');
      this.instanceStore.setSelectedInstance(liveId);
      void this.router.navigate(['/']);
      return;
    }

    const restoreResult = await this.historyStore.restoreEntry(
      result.id,
      result.workingDirectory || undefined
    );
    if (restoreResult.success && restoreResult.instanceId) {
      this.instanceStore.setSelectedInstance(restoreResult.instanceId);
    }
    void this.router.navigate(['/']);
  }

  goBack(): void {
    void this.router.navigate(['/']);
  }

  formatTime(ts: number): string {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return 'now';
    if (diff < hour) return Math.floor(diff / min) + 'm';
    if (diff < day) return Math.floor(diff / hour) + 'h';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd';
    return new Date(ts).toLocaleDateString();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.query()) {
      this.clear();
    } else {
      this.goBack();
    }
  }

  private entryMatches(entry: ConversationHistoryEntry, q: string): boolean {
    return (
      entry.displayName.toLowerCase().includes(q)
      || entry.firstUserMessage.toLowerCase().includes(q)
      || entry.lastUserMessage.toLowerCase().includes(q)
      || entry.workingDirectory.toLowerCase().includes(q)
    );
  }

  private entryToResult(entry: ConversationHistoryEntry): SearchResult {
    const projectName = this.deriveProjectName(entry.workingDirectory);
    const subtitle = projectName
      ? projectName + (entry.workingDirectory ? '  ·  ' + entry.workingDirectory : '')
      : entry.workingDirectory;

    const snippetSource = entry.lastUserMessage || entry.firstUserMessage || '';
    const snippet = snippetSource.length > SNIPPET_MAX
      ? snippetSource.slice(0, SNIPPET_MAX) + '…'
      : snippetSource;

    return {
      kind: 'session',
      id: entry.id,
      title: entry.displayName || 'Untitled session',
      subtitle,
      workingDirectory: entry.workingDirectory,
      snippet,
      timestamp: entry.endedAt ?? entry.createdAt ?? 0,
    };
  }

  private deriveProjectName(wd: string): string {
    if (!wd) return '';
    const parts = wd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }
}
