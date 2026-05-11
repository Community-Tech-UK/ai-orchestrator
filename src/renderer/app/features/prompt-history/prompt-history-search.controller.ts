import { Injectable, computed, inject, signal } from '@angular/core';
import { matchesOverlayQuery } from '../../shared/utils/overlay-search';
import { InstanceStore } from '../../core/state/instance.store';
import {
  PromptHistoryStore,
  type PromptRecallScope,
} from '../../core/state/prompt-history.store';
import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';

export const PROMPT_HISTORY_RECALL_SCOPE_STORAGE_KEY = 'prompt-history-recall-scope';

export interface PromptRecallScopeOption {
  id: PromptRecallScope;
  label: string;
}

const PROMPT_RECALL_SCOPE_OPTIONS: PromptRecallScopeOption[] = [
  { id: 'thread', label: 'Thread' },
  { id: 'project', label: 'Project' },
  { id: 'all', label: 'All' },
];

function isPromptRecallScope(value: string | null): value is PromptRecallScope {
  return value === 'thread' || value === 'project' || value === 'all';
}

function readStoredScope(): PromptRecallScope {
  if (typeof window === 'undefined') {
    return 'project';
  }

  try {
    const stored = window.localStorage?.getItem(PROMPT_HISTORY_RECALL_SCOPE_STORAGE_KEY) ?? null;
    return isPromptRecallScope(stored) ? stored : 'project';
  } catch {
    return 'project';
  }
}

function persistScope(scope: PromptRecallScope): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage?.setItem(PROMPT_HISTORY_RECALL_SCOPE_STORAGE_KEY, scope);
  } catch {
    // Local storage can be unavailable in hardened browser contexts; recall still works for this session.
  }
}

@Injectable({ providedIn: 'root' })
export class PromptHistorySearchController implements OverlayController<PromptHistoryEntry> {
  private readonly promptHistoryStore = inject(PromptHistoryStore);
  private readonly instanceStore = inject(InstanceStore);

  readonly title = 'Prompt history';
  readonly placeholder = 'Search past prompts...';
  readonly emptyLabel = 'No prompt history found';
  readonly query = signal('');
  readonly scopeOptions = PROMPT_RECALL_SCOPE_OPTIONS;
  readonly scope = signal<PromptRecallScope>(readStoredScope());

  private readonly entries = computed(() => {
    const instance = this.instanceStore.selectedInstance();
    if (!instance) {
      return [];
    }
    return this.promptHistoryStore.getEntriesForRecall({
      scope: this.scope(),
      instanceId: instance.id,
      workingDirectory: instance.workingDirectory,
    });
  });

  readonly groups = computed<OverlayGroup<PromptHistoryEntry>[]>(() => {
    const query = this.query().trim().toLowerCase();
    const items = this.entries()
      .filter((entry) => this.matches(entry, query))
      .map((entry) => this.toOverlayItem(entry));

    return [{ id: 'prompts', label: this.groupLabel(), items }];
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  setScope(scope: PromptRecallScope): void {
    this.scope.set(scope);
    persistScope(scope);
  }

  run(item: OverlayItem<PromptHistoryEntry>): boolean {
    const entry = this.scope() === 'all'
      ? this.toTextOnlyRecallEntry(item.value)
      : item.value;
    this.promptHistoryStore.requestRecallEntry(entry);
    return true;
  }

  attachmentRecallNote(entry: PromptHistoryEntry): string | null {
    if (this.scope() !== 'all') {
      return null;
    }

    const attachmentCount = (entry as { attachmentCount?: unknown }).attachmentCount;
    if (typeof attachmentCount !== 'number' || attachmentCount <= 0) {
      return null;
    }

    return 'Attachments are not recalled in all-project mode';
  }

  private toOverlayItem(entry: PromptHistoryEntry): OverlayItem<PromptHistoryEntry> {
    const firstLine = entry.text.split('\n')[0] || entry.text;
    const sourceProject = entry.projectPath?.trim();
    const description = this.scope() === 'all'
      ? (sourceProject ? `From ${sourceProject}` : 'From unknown project')
      : entry.projectPath;
    return {
      id: entry.id,
      label: firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine,
      description,
      detail: new Date(entry.createdAt).toLocaleString(),
      badge: entry.wasSlashCommand ? 'Command' : entry.provider,
      keywords: [entry.text, entry.projectPath ?? '', entry.provider ?? '', entry.model ?? ''],
      value: entry,
    };
  }

  private groupLabel(): string {
    switch (this.scope()) {
      case 'thread':
        return 'Thread Prompts';
      case 'all':
        return 'All Project Prompts';
      case 'project':
        return 'Project Prompts';
    }
  }

  private toTextOnlyRecallEntry(entry: PromptHistoryEntry): PromptHistoryEntry {
    return {
      id: entry.id,
      text: entry.text,
      createdAt: entry.createdAt,
      projectPath: entry.projectPath,
      provider: entry.provider,
      model: entry.model,
      wasSlashCommand: entry.wasSlashCommand,
    };
  }

  private matches(entry: PromptHistoryEntry, query: string): boolean {
    return matchesOverlayQuery([
      entry.text,
      entry.projectPath ?? '',
      entry.provider ?? '',
      entry.model ?? '',
    ], query);
  }
}
