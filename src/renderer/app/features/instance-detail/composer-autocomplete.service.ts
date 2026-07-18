import { inject, Injectable, OnDestroy } from '@angular/core';

import type { HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { fuzzyRank } from '../../shared/utils/fuzzy';

export type ComposerCompletionKind = 'slash-command' | 'file' | 'symbol';

export interface ComposerCompletionItem {
  readonly kind: ComposerCompletionKind;
  readonly label: string;
  readonly insertText: string;
  readonly detail?: string;
}

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 24;
const COMPLETION_LIMIT = 8;

/** Per-composer debounced file-completion search with stale-result fencing. */
@Injectable()
export class ComposerAutocompleteService implements OnDestroy {
  private readonly codebaseIpc = inject(CodebaseIpcService);
  private generation = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: ((items: ComposerCompletionItem[]) => void) | null = null;

  searchFiles(query: string, workspaceCwd: string | null): Promise<ComposerCompletionItem[]> {
    this.cancelPending();
    const generation = this.generation;

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.pendingResolve = null;
        void this.runSearch(query, workspaceCwd, generation).then(resolve);
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  cancelPending(): void {
    this.generation++;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingResolve?.([]);
    this.pendingResolve = null;
  }

  ngOnDestroy(): void {
    this.cancelPending();
  }

  private async runSearch(
    query: string,
    workspaceCwd: string | null,
    generation: number,
  ): Promise<ComposerCompletionItem[]> {
    const response = await this.codebaseIpc.search({
      query,
      storeId: 'default',
      workspacePath: workspaceCwd ?? undefined,
      topK: SEARCH_LIMIT,
    });
    if (generation !== this.generation || !response.success) {
      return [];
    }
    return completionItemsFromSearchResults(
      response.data ?? [],
      query,
      workspaceCwd,
    ).slice(0, COMPLETION_LIMIT);
  }
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

  return fuzzyRank(query, items, item => `${item.label} ${item.detail ?? ''}`)
    .map(result => result.item);
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
