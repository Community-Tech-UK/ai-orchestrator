import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';
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
  PromptHistoryFileStore,
  type PromptHistoryStoreBackend,
} from './prompt-history-store';
import {
  getProjectMemoryLookupKeys,
  normalizeProjectMemoryKey,
} from '../memory/project-memory-key';

const logger = getLogger('PromptHistoryService');

const DAY_MS = 24 * 60 * 60_000;
/** The most recently used sessions are kept whatever else the cleanup decides. */
export const PROMPT_HISTORY_RECENT_SESSIONS_KEPT = 200;
/** Ceiling on stored sessions; recording past it runs the session cleanup. */
export const PROMPT_HISTORY_MAX_SESSIONS = 2_000;
/** Sessions with 2+ prompts, and project lists, are kept this long after last use. */
export const PROMPT_HISTORY_RETENTION_MS = 90 * DAY_MS;
/**
 * A project list whose folder is missing on this computer is kept this long.
 * Finished queue worktrees disappear; work on other computers has paths that
 * never exist here.
 */
export const PROMPT_HISTORY_MISSING_FOLDER_GRACE_MS = 7 * DAY_MS;

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

function newestEntryAt(entries: PromptHistoryEntry[]): number {
  return entries.reduce((newest, entry) => Math.max(newest, entry.createdAt), 0);
}

/**
 * Keep the recent sessions, plus sessions with real back-and-forth (2+
 * prompts) used within the retention window. Most single-prompt sessions are
 * ones Harness started itself (queue workers, automations, children).
 */
function retainSessions(
  byInstance: Record<string, PromptHistoryRecord>,
  now: number,
): Record<string, PromptHistoryRecord> {
  const records = Object.entries(byInstance)
    .map(([instanceId, record]) => ({
      instanceId,
      record: {
        ...record,
        entries: dedupeByText(record.entries.map(cloneEntry)).slice(0, PROMPT_HISTORY_MAX),
      },
    }))
    .filter(({ record }) => record.entries.length > 0)
    .sort((left, right) => right.record.updatedAt - left.record.updatedAt);
  const kept = records
    .filter(({ record }, index) => index < PROMPT_HISTORY_RECENT_SESSIONS_KEPT
      || (record.entries.length >= 2 && now - record.updatedAt < PROMPT_HISTORY_RETENTION_MS))
    .slice(0, PROMPT_HISTORY_MAX_SESSIONS);
  return Object.fromEntries(kept.map(({ instanceId, record }) => [instanceId, record]));
}

function retainProjects(
  byProject: Record<string, PromptHistoryProjectAlias>,
  now: number,
  existingFolders: ReadonlySet<string>,
): Record<string, PromptHistoryProjectAlias> {
  return Object.fromEntries(Object.entries(byProject).filter(([projectKey, alias]) => {
    const age = now - newestEntryAt(alias.entries);
    return alias.entries.length > 0
      && age < PROMPT_HISTORY_RETENTION_MS
      && (existingFolders.has(projectKey) || age < PROMPT_HISTORY_MISSING_FOLDER_GRACE_MS);
  }));
}

/** normalizeProjectMemoryKey does a realpath; resolve each distinct path once per scan. */
function createProjectKeyResolver(): (projectPath: string) => string {
  const keys = new Map<string, string>();
  return (projectPath) => {
    let key = keys.get(projectPath);
    if (key === undefined) {
      key = normalizeProjectMemoryKey(projectPath);
      keys.set(projectPath, key);
    }
    return key;
  };
}

async function findExistingFolders(folders: string[]): Promise<Set<string>> {
  const checks = await Promise.all(folders.map((folder) =>
    fs.promises.access(folder).then(() => folder, () => null)));
  return new Set(checks.filter((folder): folder is string => folder !== null));
}

export class PromptHistoryService {
  private readonly store: PromptHistoryStoreBackend;
  private readonly listeners = new Set<(delta: PromptHistoryDelta) => void>();
  /** Recording never trims sessions before the startup cleanup has kept its backup copy. */
  private startupCleanupDone = false;

  constructor(store?: PromptHistoryStoreBackend) {
    this.store = store
      ?? new PromptHistoryFileStore(path.join(app.getPath('userData'), 'prompt-history.json'));
    this.ensureInitialized();
  }

  static getInstance(): PromptHistoryService {
    if (!instance) {
      const created = new PromptHistoryService();
      registerCleanup(() => created.flush());
      instance = created;
    }
    return instance;
  }

  /** Write any change still waiting for its background save. */
  flush(): Promise<void> {
    return this.store.flush();
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
      const keyFor = createProjectKeyResolver();
      for (const record of Object.values(this.store.get('byInstance'))) {
        for (const entry of record.entries) {
          if (entry.projectPath && keyFor(entry.projectPath) === normalized) {
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

    const now = Date.now();
    const newEntry = cloneEntry(entry);
    let byInstance = { ...this.store.get('byInstance') };
    const previous = byInstance[instanceId] ?? emptyRecord(instanceId);
    const nextRecord: PromptHistoryRecord = {
      instanceId,
      entries: dedupeByText([newEntry, ...previous.entries.map(cloneEntry)]).slice(0, PROMPT_HISTORY_MAX),
      updatedAt: now,
    };
    byInstance[instanceId] = nextRecord;
    if (this.startupCleanupDone && Object.keys(byInstance).length > PROMPT_HISTORY_MAX_SESSIONS) {
      byInstance = retainSessions(byInstance, now);
    }

    // Only this entry's project list changes. Rebuilding every list from every
    // session (normalising each entry's path with a realpath) on each prompt
    // was a large part of the main-process freeze when sending a message.
    const byProject = { ...this.store.get('byProject') };
    const projectAliases: PromptHistoryProjectAlias[] = [];
    const projectKey = normalizeProjectMemoryKey(newEntry.projectPath);
    if (projectKey) {
      const alias: PromptHistoryProjectAlias = {
        projectPath: projectKey,
        entries: dedupeByText(sortByCreatedAtDesc([
          newEntry,
          ...(byProject[projectKey]?.entries ?? []).map(cloneEntry),
        ])).slice(0, PROMPT_HISTORY_MAX),
        updatedAt: now,
      };
      byProject[projectKey] = alias;
      projectAliases.push(alias);
    }

    this.store.setMany({ byInstance, byProject });
    this.emit({ instanceId, record: nextRecord, projectAliases });
    return cloneRecord(nextRecord);
  }

  clearForInstance(instanceId: string): PromptHistoryRecord {
    const now = Date.now();
    const byInstance = { ...this.store.get('byInstance') };
    const removedIds = new Set((byInstance[instanceId]?.entries ?? []).map((entry) => entry.id));
    delete byInstance[instanceId];

    const byProject = { ...this.store.get('byProject') };
    const projectAliases: PromptHistoryProjectAlias[] = [];
    if (removedIds.size > 0) {
      const keyFor = createProjectKeyResolver();
      for (const [projectKey, alias] of Object.entries(byProject)) {
        if (!alias.entries.some((entry) => removedIds.has(entry.id))) continue;
        // Lists are deduped by text, so a removed entry can stand for the same
        // prompt in another session; take those back from the sessions left.
        const fromOtherSessions = Object.values(byInstance).flatMap((record) =>
          record.entries.filter((entry) => entry.projectPath && keyFor(entry.projectPath) === projectKey));
        const next: PromptHistoryProjectAlias = {
          projectPath: alias.projectPath,
          entries: dedupeByText(sortByCreatedAtDesc([
            ...alias.entries.filter((entry) => !removedIds.has(entry.id)),
            ...fromOtherSessions,
          ].map(cloneEntry))).slice(0, PROMPT_HISTORY_MAX),
          updatedAt: now,
        };
        if (next.entries.length > 0) {
          byProject[projectKey] = next;
        } else {
          delete byProject[projectKey];
        }
        projectAliases.push(next);
      }
    }

    this.store.setMany({ byInstance, byProject });
    const record = emptyRecord(instanceId);
    record.updatedAt = now;
    this.emit({ instanceId, record, projectAliases });
    return cloneRecord(record);
  }

  /**
   * Clean out old history at startup. The file had grown without limit (82 MB
   * and 14,552 sessions on one machine), and every byte of it was read, sent
   * to the renderer and rewritten.
   */
  async pruneOnStart(now = Date.now()): Promise<void> {
    const existingFolders = await findExistingFolders(Object.keys(this.store.get('byProject')));
    const retain = () => ({
      byInstance: retainSessions(this.store.get('byInstance'), now),
      byProject: retainProjects(this.store.get('byProject'), now, existingFolders),
    });
    const sessionsBefore = Object.keys(this.store.get('byInstance')).length;
    const projectsBefore = Object.keys(this.store.get('byProject')).length;
    let retained = retain();
    const removesHistory = Object.keys(retained.byInstance).length < sessionsBefore
      || Object.keys(retained.byProject).length < projectsBefore;
    if (removesHistory) {
      await this.store.keepBackupCopy();
      // Prompts recorded while the copy was written must survive the cleanup.
      retained = retain();
      logger.info('Cleaned out old prompt history', {
        sessionsBefore,
        sessionsAfter: Object.keys(retained.byInstance).length,
        projectsBefore,
        projectsAfter: Object.keys(retained.byProject).length,
      });
    }
    this.store.setMany({ ...retained, lastPrunedAt: now });
    this.startupCleanupDone = true;
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
      this.store.setMany(values);
    }
  }

  private emit(delta: PromptHistoryDelta): void {
    for (const listener of this.listeners) {
      listener({
        instanceId: delta.instanceId,
        record: cloneRecord(delta.record),
        ...(delta.projectAliases?.length ? { projectAliases: delta.projectAliases.map(cloneAlias) } : {}),
      });
    }
  }
}

export function getPromptHistoryService(): PromptHistoryService {
  return PromptHistoryService.getInstance();
}

export function _resetPromptHistoryServiceForTesting(): void {
  instance = null;
}
