import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { getLogger } from '../logging/logger';
import { isActiveLoopRuntimeState } from '../orchestration/loop-runtime-status';
import { getStateLookupKeys } from './session-continuity-state';
import { readContinuityPayloadReadOnly, writeContinuityPayloadAsyncAtomic } from './continuity-recovery-metadata';
import type { SessionState } from './session-continuity.types';

const logger = getLogger('ContinuityLookupIndex');
const loadCoordinator = createRequire(__filename);
const NEGATIVE_TTL_MS = 10 * 60_000;
const retryDelay = (attempts: number): number => Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4));
const safeFile = (file: string): boolean => /^[^/\\\0]+\.json$/.test(file);
type Generation = Pick<Stats, 'size' | 'mtimeMs' | 'ctimeMs' | 'ino'>;
interface Entry { file: string; keys: string[]; generation: Generation }
interface LookupFileWork { directoryReads: number; fileStats: number }
const generation = (stat: Generation): Generation => ({
  size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino,
});
const sameGeneration = (a: Generation, b: Generation): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
function keysFromRecord(value: unknown): string[] {
  const record = value as Partial<Record<'instanceId' | 'historyThreadId' | 'sessionId', unknown>> | null;
  return getStateLookupKeys({
    instanceId: typeof record?.instanceId === 'string' ? record.instanceId : '',
    historyThreadId: typeof record?.historyThreadId === 'string' ? record.historyThreadId : undefined,
    sessionId: typeof record?.sessionId === 'string' ? record.sessionId : undefined,
  });
}

/** Lazy resolution keeps session/coordinator module initialization acyclic. */
export function canBackfillContinuityIndex(): boolean {
  try {
    const { getLoopCoordinator } = loadCoordinator('../orchestration/loop-coordinator') as typeof import('../orchestration/loop-coordinator');
    return !getLoopCoordinator().getActiveLoops().some(isActiveLoopRuntimeState);
  } catch { return false; }
}

interface Options {
  stateDir: string;
  metadataDir: string;
  indexPath: string;
  readState(file: string): Promise<SessionState | null>;
  canBackfill?: () => boolean;
  now?: () => number;
}

/** Derived identifiers only. Transcript data is never duplicated in the index. */
export class SessionContinuityLookupIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly byIdentifier = new Map<string, string>();
  private readonly negatives = new Map<string, number>();
  private initialized: Promise<void> | undefined;
  private complete = false;
  private directoryGeneration: Generation | undefined;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private background: Promise<void> | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistence = Promise.resolve();
  private revision = 0;
  private readonly removedFiles = new Set<string>();
  private readonly retries = new Map<string, { generation: Generation; attempts: number; nextAt: number }>();
  private backgroundFailures = 0;
  private backgroundRetryAt = 0;

  constructor(private readonly options: Options) {}
  get(id: string): string | undefined { return this.byIdentifier.get(id.trim()); }
  isComplete(): boolean { return this.complete; }

  start(): void {
    if (this.closed || this.background || this.timer) return;
    const now = (this.options.now ?? Date.now)();
    const nextRetry = this.retries.size ? Math.min(...[...this.retries.values()].map((retry) => retry.nextAt)) : now;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.background = this.backfill().catch(() => {
        this.complete = false;
        this.backgroundRetryAt = (this.options.now ?? Date.now)() + retryDelay(++this.backgroundFailures);
        logger.warn('Continuity identifier backfill will retry');
      }).finally(() => {
        this.background = undefined;
        if (!this.closed && !this.complete) this.start();
      });
    }, Math.max(1000, nextRetry - now, this.backgroundRetryAt - now));
    this.timer.unref();
  }

  private ready(): Promise<void> {
    return this.initialized ??= (async () => {
      try {
        const raw: unknown = JSON.parse(await fs.readFile(this.options.indexPath, 'utf8'));
        const data = raw as { version?: number; entries?: Entry[] };
        if (data?.version !== 1 || !Array.isArray(data.entries)) return;
        for (const entry of data.entries) {
          if (typeof entry?.file !== 'string' || !safeFile(entry.file)
            || !Array.isArray(entry.keys) || entry.keys.length === 0 || !entry.keys.every((key) => typeof key === 'string')
            || !entry.generation || !Object.values(entry.generation).every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
          if (!this.removedFiles.has(entry.file)) this.entries.set(entry.file, entry);
        }
        this.rebuildAliases();
      } catch { /* Missing or corrupt derived data is rebuilt. */ }
    })();
  }

  private rebuildAliases(): void {
    this.byIdentifier.clear();
    for (const entry of [...this.entries.values()].sort((a, b) => a.generation.mtimeMs - b.generation.mtimeMs || a.file.localeCompare(b.file))) {
      for (const key of entry.keys) this.byIdentifier.set(key, entry.file);
    }
  }

  private async files(work?: LookupFileWork): Promise<{ file: string; stat: Stats }[]> {
    if (work) work.directoryReads++;
    const names = (await fs.readdir(this.options.stateDir)).filter(safeFile);
    const result: { file: string; stat: Stats }[] = [];
    for (let i = 0; i < names.length; i += 20) {
      const batch = await Promise.all(names.slice(i, i + 20).map(async (file) => {
        if (work) work.fileStats++;
        const stat = await fs.lstat(path.join(this.options.stateDir, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          this.complete = false;
          throw error;
        });
        return stat?.isFile() ? { file, stat } : null;
      }));
      for (const entry of batch) if (entry) result.push(entry);
    }
    return result.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.file.localeCompare(b.file));
  }

  private async invalidateChangedFiles(force = false, work?: LookupFileWork): Promise<void> {
    const stat = await fs.stat(this.options.stateDir);
    if (!force && this.directoryGeneration && sameGeneration(this.directoryGeneration, stat)) return;
    const current = await this.files(work);
    this.directoryGeneration = generation(stat);
    const names = new Set(current.map(({ file }) => file));
    for (const file of this.entries.keys()) if (!names.has(file)) this.entries.delete(file);
    for (const file of this.retries.keys()) if (!names.has(file)) this.retries.delete(file);
    for (const { file, stat: fileStat } of current) {
      const entry = this.entries.get(file);
      if (!entry || !sameGeneration(entry.generation, fileStat)) {
        this.entries.delete(file);
        this.complete = false;
      }
    }
    this.negatives.clear();
    this.rebuildAliases();
  }

  private retryFile(file: string, stat: Generation): void {
    const previous = this.retries.get(file);
    const attempts = previous && sameGeneration(previous.generation, stat) ? previous.attempts + 1 : 1;
    this.retries.set(file, { generation: generation(stat), attempts,
      nextAt: (this.options.now ?? Date.now)() + retryDelay(attempts) });
    this.entries.delete(file);
  }

  async upsert(state: Pick<SessionState, 'instanceId' | 'historyThreadId' | 'sessionId'>, work?: LookupFileWork): Promise<void> {
    await this.ready();
    const file = `${state.instanceId}.json`;
    if (this.closed || !safeFile(file)) return;
    if (work) work.fileStats++;
    const stat = await fs.lstat(path.join(this.options.stateDir, file)).catch(() => null);
    if (!stat?.isFile()) return;
    this.removedFiles.delete(file);
    this.retries.delete(file);
    this.entries.set(file, { file, keys: getStateLookupKeys(state), generation: generation(stat) });
    this.revision++;
    this.negatives.clear();
    this.rebuildAliases();
    this.schedulePersist();
  }

  remove(instanceId: string): void {
    this.removedFiles.add(`${instanceId}.json`);
    this.retries.delete(`${instanceId}.json`);
    this.entries.delete(`${instanceId}.json`);
    this.revision++;
    this.negatives.clear();
    this.rebuildAliases();
    this.schedulePersist();
  }

  async backfill(): Promise<void> {
    await this.ready();
    if (this.closed || !(this.options.canBackfill ?? canBackfillContinuityIndex)()) return;
    await this.invalidateChangedFiles();
    const files = (await this.files()).reverse();
    this.backgroundFailures = 0;
    this.backgroundRetryAt = 0;
    let unresolved = 0;
    // Small records first; existing generation-bound sidecars also avoid large reads.
    files.sort((a, b) => Number(a.stat.size > 20 * 1024 * 1024) - Number(b.stat.size > 20 * 1024 * 1024));
    for (let i = 0; i < files.length; i++) {
      if (this.closed || !(this.options.canBackfill ?? canBackfillContinuityIndex)()) return;
      const { file, stat } = files[i];
      const existing = this.entries.get(file);
      if (existing && sameGeneration(existing.generation, stat)) continue;
      const retry = this.retries.get(file);
      if (retry && sameGeneration(retry.generation, stat) && retry.nextAt > (this.options.now ?? Date.now)()) {
        unresolved++;
        continue;
      }
      const revision = this.revision;
      const meta = await readContinuityPayloadReadOnly<{
        sourceInstanceId: string; historyThreadId?: string; sessionId?: string; stateFileGeneration?: Generation;
      }>(path.join(this.options.metadataDir, file));
      const keys = meta?.sourceInstanceId === path.basename(file, '.json')
        && meta.stateFileGeneration && sameGeneration(meta.stateFileGeneration, stat)
        ? keysFromRecord({ instanceId: meta.sourceInstanceId, historyThreadId: meta.historyThreadId, sessionId: meta.sessionId })
        : keysFromRecord(await readContinuityPayloadReadOnly<SessionState>(path.join(this.options.stateDir, file)));
      const after = await fs.lstat(path.join(this.options.stateDir, file)).catch(() => null);
      if (this.closed) return;
      if (revision !== this.revision) {
        this.complete = false;
        return;
      }
      if (!after?.isFile()) {
        this.retryFile(file, stat);
        unresolved++;
        continue;
      }
      if (!sameGeneration(stat, after)) {
        this.complete = false;
        return;
      }
      // Read/decrypt errors and malformed identities cannot prove that an alias
      // is absent. Do not persist an empty entry that would survive the retry.
      if (keys.length === 0) {
        this.retryFile(file, after);
        unresolved++;
      } else {
        this.retries.delete(file);
        this.entries.set(file, { file, keys, generation: generation(after) });
      }
      if ((i + 1) % 20 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    this.rebuildAliases();
    this.complete = unresolved === 0;
    this.negatives.clear();
    this.schedulePersist();
    logger.info(this.complete ? 'Continuity identifier backfill complete' : 'Continuity identifier backfill awaits unreadable records',
      { files: this.entries.size, unresolved });
  }

  async find(id: string): Promise<SessionState | null> {
    const started = (this.options.now ?? Date.now)();
    const work: LookupFileWork = { directoryReads: 0, fileStats: 0 };
    const logLookup = (scanned: number, found: boolean): void => logger.info(
      'Identifier lookup scanned state files', { scanned, ...work, ms: (this.options.now ?? Date.now)() - started, found },
    );
    await this.ready();
    const normalized = id.trim();
    if (!normalized || this.closed) return null;
    const directFile = `${normalized}.json`;
    if (safeFile(directFile)) {
      work.fileStats++;
      const stat = await fs.lstat(path.join(this.options.stateDir, directFile)).catch(() => null);
      if (stat?.isFile()) {
        const direct = await this.options.readState(path.join(this.options.stateDir, directFile));
        if (direct && keysFromRecord(direct).includes(normalized)) {
          await this.upsert(direct, work);
          return direct;
        }
      }
    }
    await this.invalidateChangedFiles(false, work);
    if (!this.complete) this.start();
    // A new alias can come from an in-place external edit (no directory mtime change).
    // Validate file metadata before treating a complete miss as authoritative.
    if (this.complete && !this.get(normalized)) await this.invalidateChangedFiles(true, work);
    const indexed = this.get(normalized);
    if (indexed) {
      const value = await this.options.readState(path.join(this.options.stateDir, indexed));
      if (value && keysFromRecord(value).includes(normalized)) return value;
      this.entries.delete(indexed);
      this.complete = false;
      this.rebuildAliases();
    }
    const now = (this.options.now ?? Date.now)();
    if (this.complete || (this.negatives.get(normalized) ?? -Infinity) > now) {
      logLookup(0, false);
      return null;
    }
    let scanned = 0;
    let unreadable = 0;
    for (const { file } of await this.files(work)) {
      scanned++;
      const value = await this.options.readState(path.join(this.options.stateDir, file));
      const keys = keysFromRecord(value);
      if (keys.length === 0) unreadable++;
      if (value && keys.includes(normalized)) {
        await this.upsert(value, work);
        logLookup(scanned, true);
        return value;
      }
    }
    if (unreadable === 0) this.negatives.set(normalized, now + NEGATIVE_TTL_MS);
    else logger.warn('Identifier lookup has unreadable records; absence not cached', { unreadable });
    if (this.negatives.size > 1000) this.negatives.delete(this.negatives.keys().next().value!);
    logLookup(scanned, false);
    return null;
  }

  private schedulePersist(): void {
    if (this.closed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.flush(); }, 2000);
    this.persistTimer.unref();
  }
  flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const data = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    this.persistence = this.persistence.then(async () => {
      if (!this.closed) await writeContinuityPayloadAsyncAtomic(this.options.indexPath, data, () => !this.closed);
    }).catch(() => logger.warn('Continuity identifier index could not be saved; it will be rebuilt'));
    return this.persistence;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    await this.background;
    await this.persistence;
  }
}
