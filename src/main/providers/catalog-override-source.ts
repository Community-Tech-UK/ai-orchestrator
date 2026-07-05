import { EventEmitter } from 'events';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getNetworkPolicy, type NetworkRequest } from '../security/network-policy';
import type { AppSettings } from '../../shared/types/settings.types';
import {
  CATALOG_OVERRIDE_FILE_NAME,
  MAX_OVERRIDE_BYTES,
  buildLocalOverrideEntry,
  catalogOverrideKey,
  entriesToProviderMap,
  parseCatalogOverrideJson,
  providerMapToEntries,
  sameEntries,
  serializeLocalOverrideEntries,
  type CatalogOverrideEntry,
} from './catalog-override-codec';
import {
  MAX_REMOTE_REDIRECTS,
  defaultFetchText,
  defaultWatchDirectory,
  type FetchText,
  type NetworkPolicyRecorder,
  type WatchDirectory,
  type Watcher,
} from './catalog-override-io';

export const CATALOG_OVERRIDE_UPDATED_EVENT = 'updated' as const;
export { CATALOG_OVERRIDE_FILE_NAME, parseCatalogOverrideJson } from './catalog-override-codec';
export type { CatalogOverrideEntry, CatalogOverrideOrigin } from './catalog-override-codec';

const logger = getLogger('CatalogOverrideSource');
const LOCAL_WATCH_DEBOUNCE_MS = 150;
const REMOTE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_REMOTE_REFRESH_INTERVAL_MS = 1000;

type ReadFile = (filePath: string) => Promise<string>;
type WriteFile = (filePath: string, contents: string) => Promise<void>;
type Mkdir = (dirPath: string) => Promise<void>;

interface CatalogOverrideSettingsManager {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  on(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  off?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  removeListener?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
}

export interface CatalogOverrideSourceOptions {
  readFile?: ReadFile;
  writeFile?: WriteFile;
  mkdir?: Mkdir;
  watchDirectory?: WatchDirectory;
  fetchText?: FetchText;
  networkPolicy?: NetworkPolicyRecorder;
  now?: () => number;
  remoteRefreshIntervalMs?: number;
}

export class CatalogOverrideSource extends EventEmitter {
  private readonly readFile: ReadFile;
  private readonly writeFile: WriteFile;
  private readonly mkdir: Mkdir;
  private readonly watchDirectory: WatchDirectory;
  private readonly fetchText: FetchText;
  private readonly networkPolicy?: NetworkPolicyRecorder;
  private readonly now: () => number;
  private readonly remoteRefreshIntervalMs: number;

  private localFilePath: string | null = null;
  private localWatcher: Watcher | null = null;
  private localDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteTimer: ReturnType<typeof setInterval> | null = null;
  private detachSettingsListener: (() => void) | null = null;
  private localEntries: CatalogOverrideEntry[] = [];
  private remoteEntries: CatalogOverrideEntry[] = [];
  private remoteUrl = '';
  private remoteLastFetchedAt = 0;
  private remoteInflight: Promise<boolean> | null = null;
  private remoteGeneration = 0;
  private localMutationQueue: Promise<void> = Promise.resolve();

  constructor(options: CatalogOverrideSourceOptions = {}) {
    super();
    this.readFile = options.readFile ?? ((filePath) => fsp.readFile(filePath, 'utf8'));
    this.writeFile = options.writeFile ?? ((filePath, contents) => fsp.writeFile(filePath, contents, 'utf8'));
    this.mkdir = options.mkdir ?? ((dirPath) => fsp.mkdir(dirPath, { recursive: true }).then(() => undefined));
    this.watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
    this.fetchText = options.fetchText ?? defaultFetchText;
    this.networkPolicy = options.networkPolicy;
    this.now = options.now ?? Date.now;
    this.remoteRefreshIntervalMs = normalizeRemoteRefreshIntervalMs(options.remoteRefreshIntervalMs);
  }

  getEntries(): CatalogOverrideEntry[] {
    const merged = new Map<string, CatalogOverrideEntry>();
    for (const entry of this.remoteEntries) {
      merged.set(catalogOverrideKey(entry), entry);
    }
    for (const entry of this.localEntries) {
      merged.set(catalogOverrideKey(entry), entry);
    }
    return Array.from(merged.values());
  }

  async startLocal(userDataPath: string): Promise<void> {
    this.stopLocal();
    await this.mkdir(userDataPath);
    this.localFilePath = path.join(userDataPath, CATALOG_OVERRIDE_FILE_NAME);
    await this.refreshLocal();
    this.localWatcher = this.watchDirectory(userDataPath, () => this.scheduleLocalRefresh());
  }

  async ensureLocalStarted(userDataPath: string): Promise<void> {
    if (this.localFilePath) {
      return;
    }
    await this.startLocal(userDataPath);
  }

  stopLocal(): void {
    if (this.localDebounceTimer !== null) {
      clearTimeout(this.localDebounceTimer);
      this.localDebounceTimer = null;
    }
    this.localWatcher?.close();
    this.localWatcher = null;
    this.localFilePath = null;
    this.replaceLocalEntries([]);
  }

  async attachSettingsManager(settingsManager: CatalogOverrideSettingsManager): Promise<void> {
    this.detachSettingsListener?.();

    const listener = (
      key: keyof AppSettings,
      value: AppSettings[keyof AppSettings],
    ) => {
      if (key === 'modelCatalogRemoteOverrideUrl') {
        void this.setRemoteOverrideUrl(value);
      }
    };
    settingsManager.on('setting-changed', listener);
    this.detachSettingsListener = () => {
      if (typeof settingsManager.off === 'function') {
        settingsManager.off('setting-changed', listener);
      } else {
        settingsManager.removeListener?.('setting-changed', listener);
      }
    };

    await this.setRemoteOverrideUrl(settingsManager.get('modelCatalogRemoteOverrideUrl'));
  }

  stop(): void {
    this.stopLocal();
    this.stopRemoteTimer();
    this.remoteGeneration += 1;
    this.remoteUrl = '';
    this.remoteLastFetchedAt = 0;
    this.remoteInflight = null;
    this.replaceRemoteEntries([]);
    this.detachSettingsListener?.();
    this.detachSettingsListener = null;
  }

  async refreshLocal(): Promise<boolean> {
    if (!this.localFilePath) {
      return false;
    }

    let raw: string;
    try {
      raw = await this.readFile(this.localFilePath);
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return this.replaceLocalEntries([]);
      }
      logger.warn('Failed to read local model catalog override', {
        filePath: this.localFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_OVERRIDE_BYTES) {
      logger.warn('Ignoring oversized local model catalog override', {
        filePath: this.localFilePath,
        maxBytes: MAX_OVERRIDE_BYTES,
      });
      return false;
    }

    const parsed = parseCatalogOverrideJson(raw, 'local', this.now());
    if (!parsed) {
      logger.warn('Ignoring invalid local model catalog override', { filePath: this.localFilePath });
      return false;
    }
    return this.replaceLocalEntries(parsed);
  }

  async setLocalOverrideModel(
    provider: string,
    modelId: string,
    config: Record<string, unknown> = {},
  ): Promise<CatalogOverrideEntry> {
    return this.enqueueLocalMutation(async () => {
      if (!this.localFilePath) {
        throw new Error('Local model catalog override source is not started');
      }

      await this.refreshLocal();
      const entry = buildLocalOverrideEntry(provider, modelId, config, this.now());
      const entriesByProvider = entriesToProviderMap(this.localEntries);
      const existing = entriesByProvider.get(entry.provider) ?? [];
      const withoutSameId = existing.filter((candidate) => candidate.id !== entry.id);
      entriesByProvider.set(entry.provider, [...withoutSameId, entry]);

      await this.persistLocalEntries(providerMapToEntries(entriesByProvider));
      return entry;
    });
  }

  async removeLocalOverrideModel(
    provider: string | null | undefined,
    modelId: string,
  ): Promise<boolean> {
    return this.enqueueLocalMutation(async () => {
      if (!this.localFilePath) {
        throw new Error('Local model catalog override source is not started');
      }

      const id = modelId.trim();
      if (!id) {
        return false;
      }

      let normalizedProvider: string | null = null;
      if (provider !== null && provider !== undefined) {
        normalizedProvider = provider.trim().toLowerCase();
        if (!normalizedProvider) {
          return false;
        }
      }

      await this.refreshLocal();
      const entriesByProvider = entriesToProviderMap(this.localEntries);
      let removed = false;

      for (const [candidateProvider, entries] of entriesByProvider) {
        if (normalizedProvider && candidateProvider !== normalizedProvider) {
          continue;
        }
        const remaining = entries.filter((entry) => entry.id !== id);
        if (remaining.length !== entries.length) {
          removed = true;
          if (remaining.length > 0) {
            entriesByProvider.set(candidateProvider, remaining);
          } else {
            entriesByProvider.delete(candidateProvider);
          }
        }
      }

      if (!removed) {
        return false;
      }

      await this.persistLocalEntries(providerMapToEntries(entriesByProvider));
      return true;
    });
  }

  async setRemoteOverrideUrl(value: unknown): Promise<void> {
    const nextUrl = typeof value === 'string' ? value.trim() : '';
    if (nextUrl === this.remoteUrl) {
      return;
    }

    const hadRemoteEntries = this.remoteEntries.length > 0;
    this.remoteGeneration += 1;
    this.remoteUrl = nextUrl;
    this.remoteLastFetchedAt = 0;
    this.remoteInflight = null;
    this.stopRemoteTimer();
    this.remoteEntries = [];
    if (hadRemoteEntries) {
      this.emitUpdated();
    }

    if (!this.remoteUrl) {
      return;
    }

    this.ensureRemoteTimer();
    await this.refreshRemote(true);
  }

  async refreshRemote(force = false): Promise<boolean> {
    if (!this.remoteUrl) {
      return false;
    }
    if (!force && this.remoteLastFetchedAt > 0 && this.now() - this.remoteLastFetchedAt < this.remoteRefreshIntervalMs) {
      return false;
    }
    if (this.remoteInflight) {
      return this.remoteInflight;
    }
    const url = this.remoteUrl;
    const generation = this.remoteGeneration;
    const refresh = this.doRefreshRemote(url, generation);
    const wrapped = refresh.finally(() => {
      if (this.remoteInflight === wrapped) {
        this.remoteInflight = null;
      }
    });
    this.remoteInflight = wrapped;
    return this.remoteInflight;
  }

  private scheduleLocalRefresh(): void {
    if (this.localDebounceTimer !== null) {
      clearTimeout(this.localDebounceTimer);
    }
    this.localDebounceTimer = setTimeout(() => {
      this.localDebounceTimer = null;
      void this.refreshLocal();
    }, LOCAL_WATCH_DEBOUNCE_MS);
    this.localDebounceTimer.unref?.();
  }

  private async doRefreshRemote(url: string, generation: number): Promise<boolean> {
    let request: NetworkRequest;
    try {
      request = (this.networkPolicy ?? getNetworkPolicy()).recordRequest(url, 'GET');
    } catch (error) {
      logger.warn('Remote model catalog override URL is invalid', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (!request.allowed) {
      logger.warn('Remote model catalog override blocked by network policy', {
        url,
        reason: request.reason,
      });
      if (generation === this.remoteGeneration && url === this.remoteUrl) {
        this.replaceRemoteEntries([]);
      }
      return false;
    }

    let raw: string;
    try {
      raw = await this.fetchText(url, {
        networkPolicy: this.networkPolicy ?? getNetworkPolicy(),
        maxRedirects: MAX_REMOTE_REDIRECTS,
      });
    } catch (error) {
      logger.warn('Remote model catalog override fetch failed; keeping last valid override', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    const parsed = parseCatalogOverrideJson(raw, 'remote', this.now());
    if (!parsed) {
      logger.warn('Ignoring invalid remote model catalog override', { url });
      return false;
    }
    if (generation !== this.remoteGeneration || url !== this.remoteUrl) {
      return false;
    }

    this.remoteLastFetchedAt = this.now();
    return this.replaceRemoteEntries(parsed);
  }

  private replaceLocalEntries(entries: CatalogOverrideEntry[]): boolean {
    if (sameEntries(this.localEntries, entries)) {
      return false;
    }
    this.localEntries = entries;
    this.emitUpdated();
    return true;
  }

  private replaceRemoteEntries(entries: CatalogOverrideEntry[]): boolean {
    if (sameEntries(this.remoteEntries, entries)) {
      return false;
    }
    this.remoteEntries = entries;
    this.emitUpdated();
    return true;
  }

  private async persistLocalEntries(entries: CatalogOverrideEntry[]): Promise<void> {
    if (!this.localFilePath) {
      throw new Error('Local model catalog override source is not started');
    }

    const contents = serializeLocalOverrideEntries(entries);
    await this.writeFile(this.localFilePath, contents);
    this.replaceLocalEntries(entries);
  }

  private ensureRemoteTimer(): void {
    if (this.remoteTimer !== null) {
      return;
    }
    this.remoteTimer = setInterval(() => {
      void this.refreshRemote();
    }, this.remoteRefreshIntervalMs);
    this.remoteTimer.unref?.();
  }

  private stopRemoteTimer(): void {
    if (this.remoteTimer !== null) {
      clearInterval(this.remoteTimer);
      this.remoteTimer = null;
    }
  }

  private emitUpdated(): void {
    this.emit(CATALOG_OVERRIDE_UPDATED_EVENT);
  }

  private enqueueLocalMutation<T>(run: () => Promise<T>): Promise<T> {
    const queued = this.localMutationQueue.then(run, run);
    this.localMutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

let catalogOverrideSource: CatalogOverrideSource | null = null;

export function getCatalogOverrideSource(): CatalogOverrideSource {
  catalogOverrideSource ??= new CatalogOverrideSource();
  return catalogOverrideSource;
}

export function _resetCatalogOverrideSourceForTesting(): void {
  catalogOverrideSource?.stop();
  catalogOverrideSource = null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function normalizeRemoteRefreshIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return REMOTE_REFRESH_INTERVAL_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return MIN_REMOTE_REFRESH_INTERVAL_MS;
  }
  return Math.max(Math.floor(value), MIN_REMOTE_REFRESH_INTERVAL_MS);
}
