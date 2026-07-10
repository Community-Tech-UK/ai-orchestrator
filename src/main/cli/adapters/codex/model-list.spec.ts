import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppServerRequestParams,
  AppServerResponseResult,
} from './app-server-types';
import {
  CODEX_MODEL_DISCOVERY_CACHE_TTL_MS,
  _resetCodexModelCacheForTesting,
  discoverCodexModels,
  listCodexModelsFromAppServer,
} from './model-list';

interface ModelListClient {
  request: (
    method: 'model/list',
    params: AppServerRequestParams<'model/list'>,
  ) => Promise<AppServerResponseResult<'model/list'>>;
}

function codexModel(overrides: Partial<AppServerResponseResult<'model/list'>['data'][number]> = {}): AppServerResponseResult<'model/list'>['data'][number] {
  return {
    id: overrides.model ?? 'gpt-5.5',
    model: 'gpt-5.5',
    displayName: 'gpt-5.5',
    description: '',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: [],
    ...overrides,
  };
}

function makeClient(pages: AppServerResponseResult<'model/list'>[]): ModelListClient {
  const queue = [...pages];
  return {
    request: vi.fn(async () => {
      const page = queue.shift();
      if (!page) {
        return { data: [], nextCursor: null };
      }
      return page;
    }),
  };
}

describe('Codex app-server model/list discovery', () => {
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  beforeEach(() => {
    _resetCodexModelCacheForTesting();
  });

  it('walks paginated model/list responses and maps them into picker model metadata', async () => {
    const client = makeClient([
      {
        data: [
          codexModel({
            id: 'codex-gpt-5-5',
            model: 'gpt-5.5',
            displayName: 'gpt-5.5',
            isDefault: true,
          }),
        ],
        nextCursor: 'cursor-2',
      },
      {
        data: [
          codexModel({
            id: 'codex-spark',
            model: 'gpt-5.3-codex-spark',
            displayName: 'GPT-5.3 Codex Spark',
          }),
        ],
        nextCursor: null,
      },
    ]);

    const models = await listCodexModelsFromAppServer(client);

    expect(models).toEqual([
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        tier: 'powerful',
        family: 'GPT',
        pinned: true,
      },
      {
        id: 'gpt-5.3-codex-spark',
        name: 'GPT-5.3 Codex Spark',
        tier: 'fast',
        family: 'GPT',
      },
    ]);
    expect(client.request).toHaveBeenNthCalledWith(1, 'model/list', {
      includeHidden: false,
      limit: 100,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, 'model/list', {
      cursor: 'cursor-2',
      includeHidden: false,
      limit: 100,
    });
  });

  it('enriches the live GPT-5.6 family with canonical static names and tiers', async () => {
    const client = makeClient([{
      data: [
        codexModel({ model: 'gpt-5.6-sol', displayName: 'gpt-5.6-sol', isDefault: true }),
        codexModel({ model: 'gpt-5.6-terra', displayName: 'gpt-5.6-terra' }),
        codexModel({ model: 'gpt-5.6-luna', displayName: 'gpt-5.6-luna' }),
      ],
      nextCursor: null,
    }]);

    await expect(listCodexModelsFromAppServer(client)).resolves.toEqual([
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', tier: 'powerful', family: 'GPT', pinned: true },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', tier: 'balanced', family: 'GPT' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', tier: 'fast', family: 'GPT' },
    ]);
  });

  it('dedupes by runnable model slug and ignores hidden or malformed entries', async () => {
    const client = makeClient([
      {
        data: [
          codexModel({ id: 'first', model: 'gpt-5.4', displayName: 'GPT-5.4' }),
          codexModel({ id: 'duplicate', model: 'gpt-5.4', displayName: 'Duplicate GPT-5.4' }),
          codexModel({ id: 'hidden', model: 'gpt-5.5-hidden', hidden: true }),
          codexModel({ id: '', model: '', displayName: '' }),
        ],
        nextCursor: null,
      },
    ]);

    const models = await listCodexModelsFromAppServer(client);

    expect(models.map((model) => model.id)).toEqual(['gpt-5.4']);
    expect(models[0]?.name).toBe('GPT-5.4');
  });

  it('caches successful discovery results for five minutes and refreshes after expiry', async () => {
    let now = 10_000;
    let discoveryCount = 0;
    const connect = vi.fn(async (run: (client: ModelListClient) => Promise<unknown>) => run(makeClient([
      {
        data: [
          codexModel({
            id: `page-${++discoveryCount}`,
            model: `gpt-5.${discoveryCount}`,
            displayName: `GPT-5.${discoveryCount}`,
          }),
        ],
        nextCursor: null,
      },
    ])));

    const first = await discoverCodexModels({ connect, now: () => now });
    const second = await discoverCodexModels({
      connect,
      now: () => now + CODEX_MODEL_DISCOVERY_CACHE_TTL_MS - 1,
    });
    now += CODEX_MODEL_DISCOVERY_CACHE_TTL_MS + 1;
    const third = await discoverCodexModels({ connect, now: () => now });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
    expect(first[0]?.id).toBe('gpt-5.1');
    expect(third[0]?.id).toBe('gpt-5.2');
  });

  it('keys cached discovery results by effective model/list options', async () => {
    let now = 20_000;
    const connect = vi.fn(async (run: (client: ModelListClient) => Promise<unknown>) => run(makeClient([
      {
        data: [
          codexModel({
            id: 'visible',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
          }),
          codexModel({
            id: 'hidden',
            model: 'gpt-5.5-hidden',
            displayName: 'GPT-5.5 Hidden',
            hidden: true,
          }),
        ],
        nextCursor: null,
      },
    ])));

    const visibleOnly = await discoverCodexModels({
      connect,
      includeHidden: false,
      now: () => now,
    });
    now += 1;
    const includingHidden = await discoverCodexModels({
      connect,
      includeHidden: true,
      now: () => now,
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(visibleOnly.map((model) => model.id)).toEqual(['gpt-5.5']);
    expect(includingHidden.map((model) => model.id)).toEqual(['gpt-5.5', 'gpt-5.5-hidden']);
  });

  it('rejects empty discovery results so callers can choose their own fallback', async () => {
    const connect = vi.fn(async (run: (client: ModelListClient) => Promise<unknown>) => run(makeClient([
      { data: [], nextCursor: null },
    ])));

    await expect(discoverCodexModels({ connect })).rejects.toThrow('Codex model/list returned no models');
  });

  it('ignores model ids beyond the dynamic catalog limit', async () => {
    const client = makeClient([
      {
        data: [
          codexModel({
            id: tooLongCatalogModelId,
            model: tooLongCatalogModelId,
            displayName: 'Too long',
          }),
          codexModel({
            id: 'gpt-5.5',
            model: 'gpt-5.5',
            displayName: 'GPT-5.5',
          }),
        ],
        nextCursor: null,
      },
    ]);

    expect(tooLongCatalogModelId).toHaveLength(513);

    const models = await listCodexModelsFromAppServer(client);

    expect(models.map((model) => model.id)).toEqual(['gpt-5.5']);
  });
});
