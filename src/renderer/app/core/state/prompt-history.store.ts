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
import { normalizeCrossPlatformPath } from '../../../../shared/utils/cross-platform-path';

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
    const removedIds = new Set(this.getEntriesForInstance(instanceId).map((entry) => entry.id));
    this._byInstance.update((records) => {
      const next = { ...records };
      delete next[instanceId];
      return next;
    });
    this.removeFromProjectAliases(removedIds);

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

  /**
   * Main keys project lists by a realpath-normalised path the renderer cannot
   * compute. Each entry keeps the folder path it was recorded with, so map
   * those paths back to the list holding them: a session in a folder reached
   * through a symlink still finds its project's prompts.
   */
  private readonly projectKeysByPath = computed(() => {
    const index = new Map<string, Set<string>>();
    for (const [key, alias] of Object.entries(this._byProject())) {
      for (const entry of alias.entries) {
        const entryPath = entry.projectPath ? normalizeCrossPlatformPath(entry.projectPath) : '';
        if (!entryPath || entryPath === key) continue;
        const keys = index.get(entryPath) ?? new Set<string>();
        keys.add(key);
        index.set(entryPath, keys);
      }
    }
    return index;
  });

  getEntriesForProject(projectPath: string): readonly PromptHistoryEntry[] {
    const trimmed = projectPath.trim();
    const normalized = normalizeCrossPlatformPath(trimmed);
    const aliases = this._byProject();
    const keys = new Set([trimmed, normalized, ...(this.projectKeysByPath().get(normalized) ?? [])]);
    const lists = [...keys].map((key) => aliases[key]?.entries ?? []).filter((entries) => entries.length > 0);
    if (lists.length <= 1) {
      return lists[0] ?? [];
    }
    return dedupeByText(lists.flat().sort((left, right) => right.createdAt - left.createdAt))
      .slice(0, PROMPT_HISTORY_MAX);
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
    if (delta.projectAliases?.length) {
      const changed = delta.projectAliases;
      this._byProject.update((aliases) => {
        const next = { ...aliases };
        for (const alias of changed) {
          if (alias.entries.length === 0) {
            delete next[alias.projectPath];
          } else {
            next[alias.projectPath] = alias;
          }
        }
        return next;
      });
    }
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
    const projectPath = entry.projectPath ? normalizeCrossPlatformPath(entry.projectPath) : '';
    if (projectPath) {
      this._byProject.update((aliases) => ({
        ...aliases,
        [projectPath]: {
          projectPath,
          entries: dedupeByText([entry, ...(aliases[projectPath]?.entries ?? [])]).slice(0, PROMPT_HISTORY_MAX),
          updatedAt: Date.now(),
        },
      }));
    }
    return nextRecord;
  }

  private removeFromProjectAliases(entryIds: ReadonlySet<string>): void {
    if (entryIds.size === 0) return;
    this._byProject.update((aliases) => {
      const next: Record<string, PromptHistoryProjectAlias> = {};
      for (const [key, alias] of Object.entries(aliases)) {
        const entries = alias.entries.filter((entry) => !entryIds.has(entry.id));
        if (entries.length === alias.entries.length) {
          next[key] = alias;
        } else if (entries.length > 0) {
          next[key] = { ...alias, entries };
        }
      }
      return next;
    });
  }

  private bumpRevision(instanceId: string): number {
    const next = (this.mutationRevisions.get(instanceId) ?? 0) + 1;
    this.mutationRevisions.set(instanceId, next);
    return next;
  }
}
