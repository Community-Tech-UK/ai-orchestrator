import { Injectable, computed, inject, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';
import type { OverlayController, OverlayGroup, OverlayItem } from '../overlay/overlay.types';

@Injectable({ providedIn: 'root' })
export class PromptHistorySearchController implements OverlayController<PromptHistoryEntry> {
  private readonly promptHistoryStore = inject(PromptHistoryStore);
  private readonly instanceStore = inject(InstanceStore);

  readonly title = 'Prompt history';
  readonly placeholder = 'Search past prompts...';
  readonly emptyLabel = 'No prompt history found';
  readonly query = signal('');

  private readonly entries = computed(() => {
    const instance = this.instanceStore.selectedInstance();
    if (!instance) {
      return [];
    }
    return this.promptHistoryStore.getEntriesForRecall(instance.id, instance.workingDirectory);
  });

  readonly groups = computed<OverlayGroup<PromptHistoryEntry>[]>(() => {
    const query = this.query().trim().toLowerCase();
    const items = this.entries()
      .filter((entry) => this.matches(entry, query))
      .map((entry) => this.toOverlayItem(entry));

    return [{ id: 'prompts', label: 'Recent Prompts', items }];
  });

  setQuery(query: string): void {
    this.query.set(query);
  }

  run(item: OverlayItem<PromptHistoryEntry>): boolean {
    this.promptHistoryStore.requestRecallEntry(item.value);
    return true;
  }

  private toOverlayItem(entry: PromptHistoryEntry): OverlayItem<PromptHistoryEntry> {
    const firstLine = entry.text.split('\n')[0] || entry.text;
    return {
      id: entry.id,
      label: firstLine.length > 90 ? `${firstLine.slice(0, 87)}...` : firstLine,
      description: entry.projectPath,
      detail: new Date(entry.createdAt).toLocaleString(),
      badge: entry.wasSlashCommand ? 'Command' : entry.provider,
      keywords: [entry.text, entry.projectPath ?? '', entry.provider ?? '', entry.model ?? ''],
      value: entry,
    };
  }

  private matches(entry: PromptHistoryEntry, query: string): boolean {
    if (!query) return true;
    return [
      entry.text,
      entry.projectPath ?? '',
      entry.provider ?? '',
      entry.model ?? '',
    ].some((value) => value.toLowerCase().includes(query));
  }
}
