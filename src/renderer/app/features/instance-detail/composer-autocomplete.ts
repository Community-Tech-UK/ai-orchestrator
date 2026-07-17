import {
  Component,
  ChangeDetectionStrategy,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  inject,
  signal,
} from '@angular/core';
import type { HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { fuzzyRank } from '../../shared/utils/fuzzy';

export type ComposerCompletionKind = 'slash-command' | 'file' | 'symbol';

export interface ComposerCompletionQuery {
  readonly kind: ComposerCompletionKind;
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

export interface ComposerCompletionItem {
  readonly kind: ComposerCompletionKind;
  readonly label: string;
  readonly insertText: string;
  readonly detail?: string;
}

const COMPLETION_LIMIT = 8;
const SEARCH_LIMIT = 24;

@Component({
  selector: 'app-composer-autocomplete',
  standalone: true,
  template: `
    @if (isOpen()) {
      <div class="composer-completions" role="listbox" aria-label="Composer completions">
        @for (item of items(); track item.kind + ':' + item.insertText; let i = $index) {
          <button
            type="button"
            class="composer-completion-item"
            role="option"
            [class.selected]="i === selectedIndex()"
            [attr.aria-selected]="i === selectedIndex()"
            (mousedown)="onItemMouseDown($event)"
            (mouseenter)="selectedIndex.set(i)"
            (click)="acceptItem(item)"
          >
            <span class="completion-label">{{ item.label }}</span>
            @if (item.detail) {
              <span class="completion-detail">{{ item.detail }}</span>
            }
          </button>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      display: contents;
    }

    .composer-completions {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 100%;
      z-index: 302;
      max-height: 260px;
      margin-bottom: var(--spacing-sm);
      overflow-y: auto;
      border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 18px;
      background: rgba(11, 16, 15, 0.96);
      box-shadow: 0 -12px 28px rgba(0, 0, 0, 0.22);
    }

    .composer-completion-item {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      border: 0;
      border-bottom: 1px solid var(--border-subtle);
      background: transparent;
      color: var(--text-secondary);
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .composer-completion-item:last-child {
      border-bottom: 0;
    }

    .composer-completion-item:hover,
    .composer-completion-item.selected {
      background: rgba(var(--primary-rgb), 0.1);
    }

    .completion-label {
      min-width: 0;
      overflow: hidden;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .completion-detail {
      max-width: 180px;
      overflow: hidden;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerAutocompleteComponent implements OnChanges, OnDestroy {
  private readonly codebaseIpc = inject(CodebaseIpcService);
  private searchGeneration = 0;
  private unbindTextarea: (() => void) | null = null;

  @Input() textarea: HTMLTextAreaElement | null = null;
  @Input() workspaceCwd: string | null = null;
  protected readonly query = signal<ComposerCompletionQuery | null>(null);
  protected readonly items = signal<ComposerCompletionItem[]>([]);
  protected readonly selectedIndex = signal(0);
  protected readonly isOpen = computed(() => this.query()?.kind === 'file' && this.items().length > 0);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['textarea']) {
      this.bindTextarea(this.textarea);
      return;
    }
    if (changes['workspaceCwd'] && this.textarea) {
      void this.refreshFromTextarea(this.textarea);
    }
  }

  ngOnDestroy(): void {
    this.unbindTextarea?.();
  }

  protected onItemMouseDown(event: MouseEvent): void {
    event.preventDefault();
  }

  protected acceptItem(item: ComposerCompletionItem): void {
    const textarea = this.textarea;
    if (!textarea) return;
    this.acceptCompletion(textarea, item);
  }

  private bindTextarea(textarea: HTMLTextAreaElement | null): void {
    this.unbindTextarea?.();
    this.unbindTextarea = null;
    this.close();

    if (!textarea) return;

    const inputListener = () => {
      void this.refreshFromTextarea(textarea);
    };
    const keydownListener = (event: KeyboardEvent) => {
      this.onTextareaKeydown(event, textarea);
    };
    const blurListener = () => {
      this.close();
    };

    textarea.addEventListener('input', inputListener);
    textarea.addEventListener('keydown', keydownListener, true);
    textarea.addEventListener('blur', blurListener);
    this.unbindTextarea = () => {
      textarea.removeEventListener('input', inputListener);
      textarea.removeEventListener('keydown', keydownListener, true);
      textarea.removeEventListener('blur', blurListener);
    };
    void this.refreshFromTextarea(textarea);
  }

  private onTextareaKeydown(event: KeyboardEvent, textarea: HTMLTextAreaElement): void {
    if (!this.isOpen()) return;

    const items = this.items();
    switch (event.key) {
      case 'ArrowDown':
        this.consumeKeyboardEvent(event);
        this.selectedIndex.update(index => index < items.length - 1 ? index + 1 : 0);
        return;
      case 'ArrowUp':
        this.consumeKeyboardEvent(event);
        this.selectedIndex.update(index => index > 0 ? index - 1 : items.length - 1);
        return;
      case 'Tab':
      case 'Enter': {
        this.consumeKeyboardEvent(event);
        const selected = items[this.selectedIndex()];
        if (selected) {
          this.acceptCompletion(textarea, selected);
        }
        return;
      }
      case 'Escape':
        this.consumeKeyboardEvent(event);
        this.close();
        return;
    }
  }

  private consumeKeyboardEvent(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  private async refreshFromTextarea(textarea: HTMLTextAreaElement): Promise<void> {
    const query = detectComposerCompletion(textarea.value, textarea.selectionStart ?? textarea.value.length);
    this.query.set(query);
    this.selectedIndex.set(0);

    if (!query || query.kind !== 'file' || query.query.length === 0) {
      this.closeItemsOnly();
      return;
    }

    const generation = ++this.searchGeneration;
    const response = await this.codebaseIpc.search({
      query: query.query,
      storeId: 'default',
      workspacePath: this.workspaceCwd ?? undefined,
      topK: SEARCH_LIMIT,
    });

    if (generation !== this.searchGeneration) return;

    const current = detectComposerCompletion(textarea.value, textarea.selectionStart ?? textarea.value.length);
    if (!sameCompletionQuery(query, current)) {
      return;
    }

    const results = response.success ? response.data ?? [] : [];
    this.items.set(completionItemsFromSearchResults(results, query.query, this.workspaceCwd).slice(0, COMPLETION_LIMIT));
  }

  private acceptCompletion(textarea: HTMLTextAreaElement, item: ComposerCompletionItem): void {
    const query = this.query();
    if (!query) return;

    const next = applyComposerCompletion(textarea.value, query, item);
    textarea.value = next.text;
    textarea.setSelectionRange(next.cursor, next.cursor);
    this.close();
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private close(): void {
    this.query.set(null);
    this.closeItemsOnly();
  }

  private closeItemsOnly(): void {
    this.searchGeneration++;
    this.items.set([]);
    this.selectedIndex.set(0);
  }
}

export function detectComposerCompletion(text: string, cursor: number): ComposerCompletionQuery | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const start = findTokenStart(text, safeCursor);
  const token = text.slice(start, safeCursor);

  if (token.startsWith('/') && start === 0) {
    return {
      kind: 'slash-command',
      query: token.slice(1),
      start,
      end: safeCursor,
    };
  }

  if (token.startsWith('@') && token.length > 1) {
    return {
      kind: 'file',
      query: token.slice(1),
      start,
      end: safeCursor,
    };
  }

  return null;
}

export function applyComposerCompletion(
  text: string,
  completion: ComposerCompletionQuery,
  item: ComposerCompletionItem,
): { text: string; cursor: number } {
  const marker = markerForKind(item.kind);
  const insertText = item.insertText.startsWith(marker) ? item.insertText : `${marker}${item.insertText}`;
  const needsTrailingSpace = item.kind === 'file' && !/\s/.test(text[completion.end] ?? '');
  const replacement = needsTrailingSpace ? `${insertText} ` : insertText;
  const nextText = `${text.slice(0, completion.start)}${replacement}${text.slice(completion.end)}`;
  return {
    text: nextText,
    cursor: completion.start + replacement.length,
  };
}

function completionItemsFromSearchResults(
  results: readonly HybridSearchResult[],
  query: string,
  workspaceCwd: string | null,
): ComposerCompletionItem[] {
  const seen = new Set<string>();
  const items = results.flatMap((result): ComposerCompletionItem[] => {
    const label = relativeFileLabel(result.filePath, workspaceCwd);
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [{
      kind: 'file',
      label,
      insertText: label,
      detail: result.symbolName ?? result.language,
    }];
  });

  return fuzzyRank(query, items, item => `${item.label} ${item.detail ?? ''}`).map(result => result.item);
}

function findTokenStart(text: string, cursor: number): number {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1]!)) {
    start--;
  }
  return start;
}

function markerForKind(kind: ComposerCompletionKind): string {
  if (kind === 'slash-command') return '/';
  if (kind === 'file') return '@';
  return '';
}

function relativeFileLabel(filePath: string, workspaceCwd: string | null): string {
  const normalizedPath = normalizePath(filePath);
  const normalizedWorkspace = normalizePath(workspaceCwd ?? '').replace(/\/$/, '');
  if (normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  return normalizedPath;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function sameCompletionQuery(
  left: ComposerCompletionQuery,
  right: ComposerCompletionQuery | null,
): boolean {
  return !!right
    && left.kind === right.kind
    && left.query === right.query
    && left.start === right.start
    && left.end === right.end;
}
