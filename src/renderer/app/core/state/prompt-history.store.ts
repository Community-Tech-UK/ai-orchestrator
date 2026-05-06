import { Injectable, computed, inject, signal } from '@angular/core';
import { PromptHistoryIpcService } from '../services/ipc';
import {
  PROMPT_HISTORY_MAX,
  type PromptHistoryDelta,
  type PromptHistoryEntry,
  type PromptHistoryProjectAlias,
  type PromptHistoryRecord,
  type PromptHistorySnapshot,
} from '../../../../shared/types/prompt-history.types';

function emptyRecord(instanceId: string): PromptHistoryRecord {
  return {
    instanceId,
    entries: [],
    updatedAt: 0,
  };
}

function dedupeByText(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  const seen = new Set<string>();
  const deduped: PromptHistoryEntry[] = [];

  for (const entry of entries) {
    const key = entry.text.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}

export type PromptRecallScope = 'thread' | 'project' | 'all';

export interface PromptRecallRequest {
  scope?: PromptRecallScope;
  instanceId: string;
  workingDirectory?: string | null;
}

@Injectable({ providedIn: 'root' })
export class PromptHistoryStore {
  private readonly ipc = inject(PromptHistoryIpcService);
  private readonly _byInstance = signal<Record<string, PromptHistoryRecord>>({});
  private readonly _byProject = signal<Record<string, PromptHistoryProjectAlias>>({});
  private readonly _requestedRecallEntry = signal<PromptHistoryEntry | null>(null);
  private unsubscribeDelta: (() => void) | null = null;
  private readonly mutationRevisions = new Map<string, number>();

  readonly records = this._byInstance.asReadonly();
  readonly projectAliases = this._byProject.asReadonly();
  readonly requestedRecallEntry = this._requestedRecallEntry.asReadonly();
  readonly initialized = signal(false);
  readonly allEntries = computed(() => {
    const entries = Object.values(this._byInstance()).flatMap((record) => record.entries);
    return dedupeByText(entries.sort((left, right) => right.createdAt - left.createdAt));
  });

  async init(): Promise<void> {
    if (this.unsubscribeDelta) {
      return;
    }

    const response = await this.ipc.getSnapshot();
    if (response.success && response.data) {
      this.applySnapshot(response.data);
    }
    this.unsubscribeDelta = this.ipc.onDelta((delta) => this.applyDelta(delta));
    this.initialized.set(true);
  }

  record(entry: PromptHistoryEntry & { instanceId: string }): void {
    const { instanceId, ...promptEntry } = entry;
    if (!promptEntry.text.trim()) {
      return;
    }

    const optimisticRecord = this.insertLocal(instanceId, promptEntry);
    const revision = this.bumpRevision(instanceId);
    void this.ipc.record(instanceId, promptEntry).then((response) => {
      if (this.mutationRevisions.get(instanceId) !== revision) {
        return;
      }
      if (response.success && response.data) {
        this.applyDelta({ instanceId, record: response.data });
      } else {
        this.applyDelta({ instanceId, record: optimisticRecord });
      }
    });
  }

  async clearForInstance(instanceId: string): Promise<void> {
    const revision = this.bumpRevision(instanceId);
    this._byInstance.update((records) => {
      const next = { ...records };
      delete next[instanceId];
      return next;
    });
    this.rebuildProjectAliases();

    const response = await this.ipc.clearInstance(instanceId);
    if (this.mutationRevisions.get(instanceId) !== revision) {
      return;
    }
    if (response.success && response.data) {
      this.applyDelta({ instanceId, record: response.data });
    }
  }

  getEntriesForInstance(instanceId: string): readonly PromptHistoryEntry[] {
    return this._byInstance()[instanceId]?.entries ?? [];
  }

  getEntriesForProject(projectPath: string): readonly PromptHistoryEntry[] {
    return this._byProject()[projectPath]?.entries ?? [];
  }

  getEntriesForRecall(request: PromptRecallRequest): readonly PromptHistoryEntry[] {
    const scope = request.scope ?? 'project';

    if (scope === 'all') {
      return this.allEntries().slice(0, PROMPT_HISTORY_MAX);
    }

    const instanceEntries = [...this.getEntriesForInstance(request.instanceId)];
    if (scope === 'thread') {
      return instanceEntries.slice(0, PROMPT_HISTORY_MAX);
    }

    const projectEntries = request.workingDirectory
      ? [...this.getEntriesForProject(request.workingDirectory)]
      : [];
    return dedupeByText([...instanceEntries, ...projectEntries]).slice(0, PROMPT_HISTORY_MAX);
  }

  requestRecallEntry(entry: PromptHistoryEntry): void {
    this._requestedRecallEntry.set(entry);
  }

  clearRequestedRecallEntry(entry?: PromptHistoryEntry): void {
    if (!entry || this._requestedRecallEntry()?.id === entry.id) {
      this._requestedRecallEntry.set(null);
    }
  }

  private applySnapshot(snapshot: PromptHistorySnapshot): void {
    this._byInstance.set(snapshot.byInstance);
    this._byProject.set(snapshot.byProject);
  }

  private applyDelta(delta: PromptHistoryDelta): void {
    this._byInstance.update((records) => {
      if (delta.record.entries.length === 0) {
        const next = { ...records };
        delete next[delta.instanceId];
        return next;
      }
      return {
        ...records,
        [delta.instanceId]: delta.record,
      };
    });
    this.rebuildProjectAliases();
  }

  private insertLocal(instanceId: string, entry: PromptHistoryEntry): PromptHistoryRecord {
    let nextRecord = emptyRecord(instanceId);
    this._byInstance.update((records) => {
      const previous = records[instanceId] ?? emptyRecord(instanceId);
      nextRecord = {
        instanceId,
        entries: dedupeByText([entry, ...previous.entries]).slice(0, PROMPT_HISTORY_MAX),
        updatedAt: Date.now(),
      };
      return {
        ...records,
        [instanceId]: nextRecord,
      };
    });
    this.rebuildProjectAliases();
    return nextRecord;
  }

  private rebuildProjectAliases(): void {
    const grouped = new Map<string, PromptHistoryEntry[]>();

    for (const record of Object.values(this._byInstance())) {
      for (const entry of record.entries) {
        const projectPath = entry.projectPath?.trim();
        if (!projectPath) {
          continue;
        }
        const entries = grouped.get(projectPath) ?? [];
        entries.push(entry);
        grouped.set(projectPath, entries);
      }
    }

    const aliases: Record<string, PromptHistoryProjectAlias> = {};
    for (const [projectPath, entries] of grouped) {
      aliases[projectPath] = {
        projectPath,
        entries: dedupeByText(entries.sort((left, right) => right.createdAt - left.createdAt))
          .slice(0, PROMPT_HISTORY_MAX),
        updatedAt: Date.now(),
      };
    }

    this._byProject.set(aliases);
  }

  private bumpRevision(instanceId: string): number {
    const next = (this.mutationRevisions.get(instanceId) ?? 0) + 1;
    this.mutationRevisions.set(instanceId, next);
    return next;
  }
}
