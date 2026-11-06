import { inject, Injectable, Injector, OnDestroy } from '@angular/core';

import type { HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { fuzzyRank } from '../../shared/utils/fuzzy';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';

export type ComposerCompletionKind = 'slash-command' | 'file' | 'symbol' | 'session';

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
  private readonly injector = inject(Injector);
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

  async searchSessions(query: string, workspaceCwd: string | null): Promise<ComposerCompletionItem[]> {
    this.cancelPending();
    const generation = this.generation;
    const history = this.injector.get(HistoryStore);
    if (!history.entries().length) await history.loadHistory();
    if (generation !== this.generation) return [];
    const instances = this.injector.get(InstanceStore).instances();
    const liveIds = new Set(instances.map((instance) => instance.id));
    const sessions = [
      ...instances.map((instance) => ({ id: instance.id, title: instance.displayName || 'Untitled session', folder: instance.workingDirectory })),
      ...history.entries().filter((entry) => !liveIds.has(entry.originalInstanceId)).map((entry) => ({ id: entry.id, title: entry.displayName || entry.aiTitle || 'Untitled session', folder: entry.workingDirectory })),
    ];
    const ranked = fuzzyRank(query, sessions, (session) => `${session.title} ${session.folder}`);
    ranked.sort((left, right) => Number(right.item.folder === workspaceCwd) - Number(left.item.folder === workspaceCwd) || right.score - left.score);
    return ranked.slice(0, COMPLETION_LIMIT).map(({ item }) => ({
      kind: 'session', label: item.title.slice(0, 60),
      insertText: `[session: ${item.title.replace(/[\]\r\n]/g, ' ').slice(0, 60)} · ${item.id}]`,
      detail: 'Read on request only. The agent opens it with read_session if it needs to.',
    }));
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
