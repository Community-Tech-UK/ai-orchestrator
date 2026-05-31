import { getLogger } from '../logging/logger';
import {
  PROMPT_HISTORY_MAX,
  type PromptHistoryDelta,
  type PromptHistoryEntry,
  type PromptHistoryProjectAlias,
  type PromptHistoryRecord,
  type PromptHistorySnapshot,
  type PromptHistoryStoreV1,
} from '../../shared/types/prompt-history.types';
import {
  createPromptHistoryElectronStore,
  type PromptHistoryStoreBackend,
} from './prompt-history-store';
import {
  getProjectMemoryLookupKeys,
  normalizeProjectMemoryKey,
} from '../memory/project-memory-key';

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

function sortByCreatedAtDesc(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  return entries.sort((left, right) => right.createdAt - left.createdAt);
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
    const byProject = this.store.get('byProject');
    const lookupKeys = getProjectMemoryLookupKeys(projectPath);
    const entries: PromptHistoryEntry[] = [];
    let updatedAt = 0;

    for (const key of lookupKeys) {
      const alias = byProject[key];
      if (!alias) {
        continue;
      }
      entries.push(...alias.entries.map(cloneEntry));
      updatedAt = Math.max(updatedAt, alias.updatedAt);
    }

    if (entries.length === 0) {
      const normalized = normalizeProjectMemoryKey(projectPath);
      for (const record of Object.values(this.store.get('byInstance'))) {
        for (const entry of record.entries) {
          if (
            entry.projectPath
            && normalizeProjectMemoryKey(entry.projectPath) === normalized
          ) {
            entries.push(cloneEntry(entry));
            updatedAt = Math.max(updatedAt, record.updatedAt);
          }
        }
      }
    }

    const normalizedProjectPath = normalizeProjectMemoryKey(projectPath) || projectPath;
    return {
      projectPath: normalizedProjectPath,
      entries: dedupeByText(sortByCreatedAtDesc(entries)).slice(0, PROMPT_HISTORY_MAX),
      updatedAt,
    };
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
    const byProject = this.buildProjectAliases(byInstance);
    this.setStoreValues({ byInstance, byProject });
    this.emit({ instanceId, record: cloneRecord(nextRecord) });
    return cloneRecord(nextRecord);
  }

  clearForInstance(instanceId: string): PromptHistoryRecord {
    const byInstance = { ...this.store.get('byInstance') };
    delete byInstance[instanceId];
    const byProject = this.buildProjectAliases(byInstance);
    this.setStoreValues({ byInstance, byProject });

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

    const values = {
      ...(changed ? { byInstance } : {}),
      byProject: this.buildProjectAliases(byInstance),
      lastPrunedAt: Date.now(),
    };
    this.setStoreValues(values);
  }

  onChange(listener: (delta: PromptHistoryDelta) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private ensureInitialized(): void {
    const values: Partial<PromptHistoryStoreV1> = {};
    if (this.store.get('schemaVersion') !== 1) {
      values.schemaVersion = 1;
    }
    if (!this.store.get('byInstance')) {
      values.byInstance = {};
    }
    if (!this.store.get('byProject')) {
      values.byProject = {};
    }
    if (Object.keys(values).length > 0) {
      this.setStoreValues(values);
    }
  }

  private setStoreValues(values: Partial<PromptHistoryStoreV1>): void {
    if (this.store.setMany) {
      this.store.setMany(values);
      return;
    }

    if (values.schemaVersion !== undefined) {
      this.store.set('schemaVersion', values.schemaVersion);
    }
    if (values.byInstance !== undefined) {
      this.store.set('byInstance', values.byInstance);
    }
    if (values.byProject !== undefined) {
      this.store.set('byProject', values.byProject);
    }
    if (values.lastPrunedAt !== undefined) {
      this.store.set('lastPrunedAt', values.lastPrunedAt);
    }
  }

  private buildProjectAliases(byInstance: Record<string, PromptHistoryRecord>): Record<string, PromptHistoryProjectAlias> {
    const grouped = new Map<string, PromptHistoryEntry[]>();

    for (const record of Object.values(byInstance)) {
      for (const entry of record.entries) {
        const projectPath = normalizeProjectMemoryKey(entry.projectPath);
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

    return byProject;
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
