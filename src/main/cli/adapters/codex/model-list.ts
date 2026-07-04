import type {
  AppServerRequestParams,
  AppServerResponseResult,
  CodexAppServerClientOptions,
  ModelListModel,
} from './app-server-types';
import { createHash } from 'crypto';
import { DEFAULT_OPT_OUT_NOTIFICATIONS } from './app-server-types';
import { withAppServer } from './app-server-client';
import {
  MAX_MODEL_ID_LENGTH,
  PROVIDER_MODEL_LIST,
  type ModelDisplayInfo,
} from '../../../../shared/types/provider.types';

export const CODEX_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 20;
const CODEX_PROVIDER = 'codex';
const CODEX_DEFAULT_MODELS = PROVIDER_MODEL_LIST[CODEX_PROVIDER] ?? [];

export interface CodexModelListClient {
  request: (
    method: 'model/list',
    params: AppServerRequestParams<'model/list'>,
  ) => Promise<AppServerResponseResult<'model/list'>>;
}

export interface ListCodexModelsOptions {
  includeHidden?: boolean;
  maxPages?: number;
  pageLimit?: number;
}

export interface DiscoverCodexModelsOptions extends ListCodexModelsOptions {
  connect?: (run: (client: CodexModelListClient) => Promise<ModelDisplayInfo[]>) => Promise<ModelDisplayInfo[]>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

interface CachedCodexModels {
  models: ModelDisplayInfo[];
  cachedAt: number;
}

const cachedCodexModels = new Map<string, CachedCodexModels>();
const codexModelDiscoveryPromises = new Map<string, Promise<ModelDisplayInfo[]>>();

export async function discoverCodexModels(
  options: DiscoverCodexModelsOptions = {},
): Promise<ModelDisplayInfo[]> {
  const now = options.now?.() ?? Date.now();
  const cacheKey = buildDiscoveryCacheKey(options);
  const cached = cachedCodexModels.get(cacheKey);
  if (
    cached
    && now - cached.cachedAt < CODEX_MODEL_DISCOVERY_CACHE_TTL_MS
  ) {
    return cached.models;
  }

  const inFlight = codexModelDiscoveryPromises.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const connect = options.connect ?? ((run) => connectToCodexAppServer(run, options));
  const discoveryPromise = connect((client) => listCodexModelsFromAppServer(client, options))
    .then((models) => {
      if (models.length === 0) {
        throw new Error('Codex model/list returned no models');
      }
      cachedCodexModels.set(cacheKey, {
        models,
        cachedAt: options.now?.() ?? Date.now(),
      });
      return models;
    })
    .finally(() => {
      codexModelDiscoveryPromises.delete(cacheKey);
    });
  codexModelDiscoveryPromises.set(cacheKey, discoveryPromise);

  return discoveryPromise;
}

export async function listCodexModelsFromAppServer(
  client: CodexModelListClient,
  options: ListCodexModelsOptions = {},
): Promise<ModelDisplayInfo[]> {
  const models: ModelDisplayInfo[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const maxPages = normalizePositiveInt(options.maxPages, DEFAULT_MAX_PAGES);

  for (let page = 0; page < maxPages; page += 1) {
    const response = await client.request('model/list', buildModelListParams(cursor, options));
    for (const model of response.data) {
      const mapped = toCodexModelDisplayInfo(model, options);
      if (!mapped || seen.has(mapped.id)) {
        continue;
      }
      seen.add(mapped.id);
      models.push(mapped);
    }

    cursor = readNonEmptyString(response.nextCursor);
    if (!cursor) {
      return models;
    }
  }

  throw new Error(`Codex model/list pagination exceeded ${maxPages} pages`);
}

export function _resetCodexModelCacheForTesting(): void {
  cachedCodexModels.clear();
  codexModelDiscoveryPromises.clear();
}

function connectToCodexAppServer(
  run: (client: CodexModelListClient) => Promise<ModelDisplayInfo[]>,
  options: DiscoverCodexModelsOptions,
): Promise<ModelDisplayInfo[]> {
  const cwd = options.cwd || process.cwd();
  const clientOptions: CodexAppServerClientOptions = {
    env: options.env,
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: DEFAULT_OPT_OUT_NOTIFICATIONS,
    },
  };
  return withAppServer(cwd, (client) => run(client), clientOptions);
}

function buildModelListParams(
  cursor: string | undefined,
  options: ListCodexModelsOptions,
): AppServerRequestParams<'model/list'> {
  return {
    ...(cursor ? { cursor } : {}),
    includeHidden: options.includeHidden ?? false,
    limit: normalizePositiveInt(options.pageLimit, DEFAULT_PAGE_LIMIT),
  };
}

function toCodexModelDisplayInfo(
  model: ModelListModel,
  options: ListCodexModelsOptions,
): ModelDisplayInfo | null {
  if (model.hidden && options.includeHidden !== true) {
    return null;
  }

  const id = readNonEmptyString(model.model) ?? readNonEmptyString(model.id);
  if (!id || id.length > MAX_MODEL_ID_LENGTH) {
    return null;
  }

  const known = CODEX_DEFAULT_MODELS.find((entry) => entry.id === id);
  return {
    id,
    name: formatCodexDisplayName(readNonEmptyString(model.displayName) ?? id),
    tier: known?.tier ?? classifyCodexModelTier(id),
    family: known?.family ?? classifyCodexModelFamily(id),
    pinned: known?.pinned || model.isDefault ? true : undefined,
  };
}

function classifyCodexModelTier(modelId: string): ModelDisplayInfo['tier'] {
  const id = modelId.toLowerCase();
  if (
    id.includes('-mini')
    || id.includes('-nano')
    || id.includes('-lite')
    || id.includes('-spark')
  ) {
    return 'fast';
  }
  if (id.includes('gpt-5.5') || id.includes('xhigh') || id.includes('max')) {
    return 'powerful';
  }
  return 'balanced';
}

function classifyCodexModelFamily(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('gpt')) return 'GPT';
  if (/^o[1-9]/.test(id)) return 'OpenAI';
  if (id.includes('codex')) return 'Codex';
  return 'Other';
}

function formatCodexDisplayName(value: string): string {
  return value
    .replace(/^gpt/i, 'GPT')
    .replace(/-([a-z])/g, (_match, letter: string) => `-${letter.toUpperCase()}`);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function buildDiscoveryCacheKey(options: DiscoverCodexModelsOptions): string {
  return JSON.stringify({
    cwd: options.cwd || process.cwd(),
    env: fingerprintEnv(options.env),
    includeHidden: options.includeHidden ?? false,
    maxPages: normalizePositiveInt(options.maxPages, DEFAULT_MAX_PAGES),
    pageLimit: normalizePositiveInt(options.pageLimit, DEFAULT_PAGE_LIMIT),
  });
}

function fingerprintEnv(env: NodeJS.ProcessEnv | undefined): string {
  if (!env) {
    return '';
  }
  const hash = createHash('sha256');
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) {
      continue;
    }
    hash.update(key);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}
