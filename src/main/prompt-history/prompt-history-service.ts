import { getLogger } from '../logging/logger';
import {
  PROMPT_HISTORY_MAX,
  type PromptHistoryDelta,
  type PromptHistoryEntry,
  type PromptHistoryProjectAlias,
  type PromptHistoryRecord,
  type PromptHistorySnapshot,
} from '../../shared/types/prompt-history.types';
import {
  createPromptHistoryElectronStore,
  type PromptHistoryStoreBackend,
} from './prompt-history-store';

const logger = getLogger('PromptHistoryService');

let instance: PromptHistoryService | null = null;

function emptyRecord(instanceId: string): PromptHistoryRecord {
  return {
    instanceId,
    entries: [],
    updatedAt: 0,
  };
}

function cloneEntry(entry: PromptHistoryEntry): PromptHistoryEntry {
  return { ...entry };
}

function cloneRecord(record: PromptHistoryRecord): PromptHistoryRecord {
  return {
    ...record,
    entries: record.entries.map(cloneEntry),
  };
}

function cloneAlias(alias: PromptHistoryProjectAlias): PromptHistoryProjectAlias {
  return {
    ...alias,
    entries: alias.entries.map(cloneEntry),
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

export class PromptHistoryService {
  private readonly store: PromptHistoryStoreBackend;
  private readonly listeners = new Set<(delta: PromptHistoryDelta) => void>();

  constructor(store?: PromptHistoryStoreBackend) {
    this.store = store ?? createPromptHistoryElectronStore();
    this.ensureInitialized();
  }

  static getInstance(): PromptHistoryService {
    if (!instance) {
      instance = new PromptHistoryService();
    }
    return instance;
  }

  getForInstance(instanceId: string): PromptHistoryRecord {
    const record = this.store.get('byInstance')[instanceId];
    return record ? cloneRecord(record) : emptyRecord(instanceId);
  }

  getForProject(projectPath: string): PromptHistoryProjectAlias {
    const alias = this.store.get('byProject')[projectPath];
    return alias
      ? cloneAlias(alias)
      : { projectPath, entries: [], updatedAt: 0 };
  }

  getSnapshot(): PromptHistorySnapshot {
    return {
      byInstance: Object.fromEntries(
        Object.entries(this.store.get('byInstance')).map(([id, record]) => [id, cloneRecord(record)]),
      ),
      byProject: Object.fromEntries(
        Object.entries(this.store.get('byProject')).map(([projectPath, alias]) => [projectPath, cloneAlias(alias)]),
      ),
    };
  }

  record(entryWithInstance: PromptHistoryEntry & { instanceId: string }): PromptHistoryRecord {
    const { instanceId, ...entry } = entryWithInstance;
    if (!entry.text.trim()) {
      return this.getForInstance(instanceId);
    }

    if (entry.text.length > 10_000) {
      logger.debug('Recording unusually large prompt history entry', {
        instanceId,
        length: entry.text.length,
      });
    }

    const byInstance = { ...this.store.get('byInstance') };
    const previous = byInstance[instanceId] ?? emptyRecord(instanceId);
    const entries = dedupeByText([cloneEntry(entry), ...previous.entries.map(cloneEntry)])
      .slice(0, PROMPT_HISTORY_MAX);
    const nextRecord: PromptHistoryRecord = {
      instanceId,
      entries,
      updatedAt: Date.now(),
    };

    byInstance[instanceId] = nextRecord;
    this.store.set('byInstance', byInstance);
    this.rebuildProjectAliases(byInstance);
    this.emit({ instanceId, record: cloneRecord(nextRecord) });
    return cloneRecord(nextRecord);
  }

  clearForInstance(instanceId: string): PromptHistoryRecord {
    const byInstance = { ...this.store.get('byInstance') };
    delete byInstance[instanceId];
    this.store.set('byInstance', byInstance);
    this.rebuildProjectAliases(byInstance);

    const record = emptyRecord(instanceId);
    record.updatedAt = Date.now();
    this.emit({ instanceId, record });
    return cloneRecord(record);
  }

  pruneOnStart(): void {
    const byInstance = { ...this.store.get('byInstance') };
    let changed = false;

    for (const [instanceId, record] of Object.entries(byInstance)) {
      const entries = dedupeByText(record.entries.map(cloneEntry)).slice(0, PROMPT_HISTORY_MAX);
      if (entries.length === 0) {
        delete byInstance[instanceId];
        changed = true;
        continue;
      }
      if (entries.length !== record.entries.length) {
        byInstance[instanceId] = {
          ...record,
          entries,
          updatedAt: Date.now(),
        };
        changed = true;
      }
    }

    if (changed) {
      this.store.set('byInstance', byInstance);
    }
    this.store.set('lastPrunedAt', Date.now());
    this.rebuildProjectAliases(byInstance);
  }

  onChange(listener: (delta: PromptHistoryDelta) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureInitialized(): void {
    if (this.store.get('schemaVersion') !== 1) {
      this.store.set('schemaVersion', 1);
    }
    if (!this.store.get('byInstance')) {
      this.store.set('byInstance', {});
    }
    if (!this.store.get('byProject')) {
      this.store.set('byProject', {});
    }
  }

  private rebuildProjectAliases(byInstance: Record<string, PromptHistoryRecord>): void {
    const grouped = new Map<string, PromptHistoryEntry[]>();

    for (const record of Object.values(byInstance)) {
      for (const entry of record.entries) {
        const projectPath = entry.projectPath?.trim();
        if (!projectPath) {
          continue;
        }
        const entries = grouped.get(projectPath) ?? [];
        entries.push(cloneEntry(entry));
        grouped.set(projectPath, entries);
      }
    }

    const byProject: Record<string, PromptHistoryProjectAlias> = {};
    for (const [projectPath, entries] of grouped) {
      const sorted = entries.sort((left, right) => right.createdAt - left.createdAt);
      byProject[projectPath] = {
        projectPath,
        entries: dedupeByText(sorted).slice(0, PROMPT_HISTORY_MAX),
        updatedAt: Date.now(),
      };
    }

    this.store.set('byProject', byProject);
  }

  private emit(delta: PromptHistoryDelta): void {
    for (const listener of this.listeners) {
      listener(delta);
    }
  }
}

export function getPromptHistoryService(): PromptHistoryService {
  return PromptHistoryService.getInstance();
}

export function _resetPromptHistoryServiceForTesting(): void {
  instance = null;
}
