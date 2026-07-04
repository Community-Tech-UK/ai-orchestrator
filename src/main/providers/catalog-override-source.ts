import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { z } from 'zod';
import { getLogger } from '../logging/logger';
import { getNetworkPolicy, type NetworkRequest } from '../security/network-policy';
import type { AppSettings } from '../../shared/types/settings.types';
import type { CatalogSource, UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';

export const CATALOG_OVERRIDE_FILE_NAME = 'models-override.json';
export const CATALOG_OVERRIDE_UPDATED_EVENT = 'updated' as const;

const logger = getLogger('CatalogOverrideSource');
const LOCAL_WATCH_DEBOUNCE_MS = 150;
const REMOTE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_REMOTE_REFRESH_INTERVAL_MS = 1000;
const REMOTE_REQUEST_TIMEOUT_MS = 6000;
const MAX_OVERRIDE_BYTES = 2 * 1024 * 1024;
const MAX_REMOTE_REDIRECTS = 5;

type CatalogOverrideOrigin = 'local' | 'remote';
interface Watcher {
  close: () => void;
}
type ReadFile = (filePath: string) => Promise<string>;
type WriteFile = (filePath: string, contents: string) => Promise<void>;
type Mkdir = (dirPath: string) => Promise<void>;
type WatchDirectory = (dirPath: string, listener: () => void) => Watcher;
interface FetchTextOptions {
  networkPolicy?: NetworkPolicyRecorder;
  maxRedirects?: number;
}
type FetchText = (url: string, options?: FetchTextOptions) => Promise<string>;
interface NetworkPolicyRecorder {
  recordRequest(url: string, method?: string): NetworkRequest;
}

interface CatalogOverrideSettingsManager {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  on(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  off?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  removeListener?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
}

export interface CatalogOverrideEntry {
  id: string;
  provider: string;
  name?: string;
  tier?: UnifiedModelEntry['tier'];
  family?: string;
  pricing?: UnifiedModelEntry['pricing'];
  contextWindow?: number;
  maxOutputTokens?: number;
  source: Extract<CatalogSource, 'catalog-override'>;
  origin: CatalogOverrideOrigin;
  discoveredAt: number;
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

const tierSchema = z.enum(['fast', 'balanced', 'powerful']);
const overrideModelSchema = z.object({
  id: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(512).optional(),
  tier: tierSchema.optional(),
  family: z.string().trim().min(1).max(128).optional(),
  pricing: z.object({
    inputPerMillion: z.number().finite().min(0),
    outputPerMillion: z.number().finite().min(0),
  }).strict().optional(),
  contextWindow: z.number().finite().int().positive().optional(),
  maxOutputTokens: z.number().finite().int().positive().optional(),
}).strict();

const overrideProviderMapSchema = z.record(
  z.string().min(1).max(128),
  z.array(overrideModelSchema).max(500),
);

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

export function parseCatalogOverrideJson(
  raw: string,
  origin: CatalogOverrideOrigin,
  discoveredAt: number,
): CatalogOverrideEntry[] | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return null;
  }

  const record = root as Record<string, unknown>;
  let providerMap: unknown = record;
  if (Object.prototype.hasOwnProperty.call(record, 'providers')) {
    if (!record['providers'] || typeof record['providers'] !== 'object' || Array.isArray(record['providers'])) {
      return null;
    }
    if (Object.keys(record).some((key) => key !== 'providers')) {
      return null;
    }
    providerMap = record['providers'];
  }
  const parsed = overrideProviderMapSchema.safeParse(providerMap);
  if (!parsed.success) {
    return null;
  }

  const entries = new Map<string, CatalogOverrideEntry>();
  for (const [rawProvider, models] of Object.entries(parsed.data)) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider) {
      return null;
    }
    for (const model of models) {
      const id = model.id.trim();
      if (!id) {
        return null;
      }
      const key = `${provider}:${id}`;
      if (entries.has(key)) {
        return null;
      }
      const entry: CatalogOverrideEntry = {
        id,
        provider,
        source: 'catalog-override',
        origin,
        discoveredAt,
        ...(model.name !== undefined ? { name: model.name.trim() } : {}),
        ...(model.tier !== undefined ? { tier: model.tier } : {}),
        ...(model.family !== undefined ? { family: model.family.trim() } : {}),
        ...(model.pricing !== undefined ? { pricing: model.pricing } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      };
      entries.set(key, entry);
    }
  }
  return Array.from(entries.values());
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

function catalogOverrideKey(entry: Pick<CatalogOverrideEntry, 'provider' | 'id'>): string {
  return `${entry.provider}:${entry.id}`;
}

function buildLocalOverrideEntry(
  provider: string,
  modelId: string,
  config: Record<string, unknown>,
  discoveredAt: number,
): CatalogOverrideEntry {
  const allowedConfig = pickSerializableOverrideConfig(config);
  const parsed = parseCatalogOverrideJson(
    JSON.stringify({
      [provider]: [{
        id: modelId,
        ...allowedConfig,
      }],
    }),
    'local',
    discoveredAt,
  );

  if (!parsed || parsed.length !== 1) {
    throw new Error('Invalid model catalog override entry');
  }
  return parsed[0];
}

function pickSerializableOverrideConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'tier', 'family', 'pricing', 'contextWindow', 'maxOutputTokens'] as const) {
    if (config[key] !== undefined) {
      result[key] = config[key];
    }
  }
  return result;
}

function entriesToProviderMap(entries: CatalogOverrideEntry[]): Map<string, CatalogOverrideEntry[]> {
  const result = new Map<string, CatalogOverrideEntry[]>();
  for (const entry of entries) {
    const current = result.get(entry.provider) ?? [];
    result.set(entry.provider, [...current, entry]);
  }
  return result;
}

function providerMapToEntries(entriesByProvider: Map<string, CatalogOverrideEntry[]>): CatalogOverrideEntry[] {
  return Array.from(entriesByProvider.values()).flat();
}

function serializeLocalOverrideEntries(entries: CatalogOverrideEntry[]): string {
  const providers: Record<string, Record<string, unknown>[]> = {};
  for (const entry of entries) {
    const models = providers[entry.provider] ?? [];
    models.push({
      id: entry.id,
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
      ...(entry.family !== undefined ? { family: entry.family } : {}),
      ...(entry.pricing !== undefined ? { pricing: entry.pricing } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    });
    providers[entry.provider] = models;
  }

  return `${JSON.stringify({ providers }, null, 2)}\n`;
}

function sameEntries(a: CatalogOverrideEntry[], b: CatalogOverrideEntry[]): boolean {
  return JSON.stringify(normalizeEntriesForComparison(a)) === JSON.stringify(normalizeEntriesForComparison(b));
}

function normalizeEntriesForComparison(
  entries: CatalogOverrideEntry[],
): Array<Omit<CatalogOverrideEntry, 'discoveredAt'>> {
  return [...entries]
    .sort((left, right) => catalogOverrideKey(left).localeCompare(catalogOverrideKey(right)))
    .map(({ discoveredAt: _discoveredAt, ...entry }) => entry);
}

function defaultWatchDirectory(dirPath: string, listener: () => void): Watcher {
  const watcher = fs.watch(dirPath, (eventType, fileName) => {
    if (eventType === 'rename' || eventType === 'change') {
      if (!fileName || fileName.toString() === CATALOG_OVERRIDE_FILE_NAME) {
        listener();
      }
    }
  });
  return watcher;
}

function defaultFetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<string> {
  return fetchTextWithRedirects(url, options, 0);
}

function fetchTextWithRedirects(
  url: string,
  options: FetchTextOptions,
  redirectCount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const client = parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null;
    if (!client) {
      reject(new Error('Only HTTP(S) catalog override URLs are supported'));
      return;
    }

    const request = client.get(parsed, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`HTTP ${status} redirect missing Location header`));
          return;
        }
        if (redirectCount >= (options.maxRedirects ?? MAX_REMOTE_REDIRECTS)) {
          reject(new Error('catalog override redirect limit exceeded'));
          return;
        }

        let redirectedUrl: string;
        try {
          redirectedUrl = new URL(location, parsed).toString();
        } catch (error) {
          reject(error);
          return;
        }

        if (options.networkPolicy) {
          let redirectedRequest: NetworkRequest;
          try {
            redirectedRequest = options.networkPolicy.recordRequest(redirectedUrl, 'GET');
          } catch (error) {
            reject(error);
            return;
          }
          if (!redirectedRequest.allowed) {
            reject(new Error(`Redirect blocked by network policy: ${redirectedRequest.reason}`));
            return;
          }
        }

        fetchTextWithRedirects(redirectedUrl, options, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OVERRIDE_BYTES) {
          request.destroy(new Error('catalog override response exceeded size cap'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.setTimeout(REMOTE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('catalog override request timed out'));
    });
    request.on('error', reject);
  });
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
