/**
 * Tests for UnifiedModelCatalogService
 *
 * Covers:
 *  - Merge precedence: CLI-discovered > models.dev > static
 *  - Curated tier/family overlay on live entries
 *  - catalog-updated event emission on source refresh
 *  - Debouncing of rapid multi-source refreshes
 *  - getModelsByProvider filtering
 *  - getModel by id
 *  - getCatalogStatus timestamps
 *  - getAllModels returns all entries
 */

import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UnifiedModelCatalogService,
  getUnifiedModelCatalog,
  CATALOG_UPDATED_EVENT,
  type CatalogUpdatedPayload,
} from '../unified-model-catalog-service';
import { clearModelRateOverlay, registerModelRates } from '../../../shared/data/model-pricing';
import {
  normalizeModelForProvider,
  type ModelDisplayInfo,
} from '../../../shared/types/provider.types';
import type { ModelsDevEntry } from '../models-dev-service';
import type { LocalModelInventoryEntry } from '../../../shared/types/local-model-runtime.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ModelsDevService mock that exposes the methods the catalog
 * service calls, including the new `listEntries()`.
 */
function makeModelsDevMock(
  contextWindows: Record<string, number> = {},
  entries: ModelsDevEntry[] = [],
): {
  getContextWindow: (id: string) => number | undefined;
  listEntries: () => ModelsDevEntry[];
  refresh: () => Promise<boolean>;
} {
  return {
    getContextWindow: (id: string) => contextWindows[id],
    listEntries: () => entries,
    refresh: vi.fn().mockResolvedValue(false),
  };
}

/**
 * Reach into the private constructor via the static instance slot to inject
 * our mock.  We reset the singleton before each test so we can construct a
 * fresh instance with injected deps.
 */
function makeServiceWithMock(
  contextWindows: Record<string, number> = {},
  devEntries: ModelsDevEntry[] = [],
): UnifiedModelCatalogService {
  UnifiedModelCatalogService._resetForTesting();
  // Inject via the public getInstance path is not possible without DI, so we
  // use the module-internal test pattern: reset + getInstance triggers the real
  // constructor which calls `getModelsDevService()`.  We need to intercept that
  // call.  Since vitest supports module mocking, we rely instead on the fact
  // that `getContextWindow` is called lazily during `rebuildCatalog`.  We can
  // install a spy via the singleton after construction.
  const svc = UnifiedModelCatalogService.getInstance();

  // Patch the private modelsDevSvc after construction so contextWindow
  // lookups and listEntries() return our test data.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).modelsDevSvc = makeModelsDevMock(contextWindows, devEntries);

  // Re-trigger the initial build so the patched mock is used.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (svc as any).rebuildCatalog([]);

  return svc;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  UnifiedModelCatalogService._resetForTesting();
  clearModelRateOverlay();
  vi.useFakeTimers();
});

afterEach(() => {
  UnifiedModelCatalogService._resetForTesting();
  clearModelRateOverlay();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UnifiedModelCatalogService — initial static catalog', () => {
  it('getAllModels returns entries for every provider in PROVIDER_MODEL_LIST', () => {
    const svc = makeServiceWithMock();
    const models = svc.getAllModels();
    expect(models.length).toBeGreaterThan(0);
    // Every entry should have required fields
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.provider).toBeTruthy();
      expect(['fast', 'balanced', 'powerful']).toContain(m.tier);
      expect(m.source).toBe('static');
    }
  });

  it('getModelsByProvider returns only entries for that provider', () => {
    const svc = makeServiceWithMock();
    const claudeModels = svc.getModelsByProvider('claude');
    expect(claudeModels.length).toBeGreaterThan(0);
    for (const m of claudeModels) {
      expect(m.provider).toBe('claude');
    }
    const copilotModels = svc.getModelsByProvider('copilot');
    expect(copilotModels.length).toBeGreaterThan(0);
    for (const m of copilotModels) {
      expect(m.provider).toBe('copilot');
    }
  });

  it('getModelsByProvider is case-insensitive', () => {
    const svc = makeServiceWithMock();
    const a = svc.getModelsByProvider('claude');
    const b = svc.getModelsByProvider('CLAUDE');
    expect(b.length).toBe(a.length);
  });

  it('getModel returns an entry by id', () => {
    const svc = makeServiceWithMock();
    // 'sonnet' is in the claude static list
    const entry = svc.getModel('sonnet');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('sonnet');
    expect(entry!.provider).toBe('claude');
  });

  it('static catalog includes Claude Fable 5 metadata', () => {
    const svc = makeServiceWithMock();
    const entry = svc.getModel('claude-fable-5');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('claude');
    expect(entry!.tier).toBe('powerful');
    expect(entry!.family).toBe('Fable');
    expect(entry!.pricing).toEqual({ inputPerMillion: 10.0, outputPerMillion: 50.0 });
  });

  it('getModel returns undefined for an unknown id', () => {
    const svc = makeServiceWithMock();
    expect(svc.getModel('definitely-not-a-real-model')).toBeUndefined();
  });
});

describe('UnifiedModelCatalogService — getCatalogStatus', () => {
  it('initial status has null refresh timestamps', () => {
    const svc = makeServiceWithMock();
    const status = svc.getCatalogStatus();
    expect(status.modelsDevLastRefreshedAt).toBeNull();
    expect(status.cliDiscoveryLastRefreshedAt).toEqual({});
    expect(status.catalogLastBuiltAt).toBeTypeOf('number');
  });

  it('modelsDevLastRefreshedAt updates after onModelsDevRefreshed', () => {
    const svc = makeServiceWithMock();
    const before = Date.now();
    svc.onModelsDevRefreshed();
    vi.runAllTimers(); // flush debounce
    expect(svc.getCatalogStatus().modelsDevLastRefreshedAt).toBeGreaterThanOrEqual(before);
  });

  it('cliDiscoveryLastRefreshedAt updates per provider after onCliDiscoveryRefreshed', () => {
    const svc = makeServiceWithMock();
    const models: ModelDisplayInfo[] = [
      { id: 'test-model', name: 'Test', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('cursor', models);
    vi.runAllTimers();
    const status = svc.getCatalogStatus();
    expect(status.cliDiscoveryLastRefreshedAt['cursor']).toBeTypeOf('number');
    expect(status.cliDiscoveryLastRefreshedAt['copilot']).toBeUndefined();
  });
});

describe('UnifiedModelCatalogService — local model inventory source', () => {
  it('adds local model inventory rows under the local-model provider', () => {
    const svc = makeServiceWithMock();
    const localModelRows: LocalModelInventoryEntry[] = [{
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      displayName: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      healthy: true,
      loaded: false,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt: 1783468800000,
    }];

    svc.onLocalModelInventoryRefreshed(localModelRows);
    vi.runAllTimers();

    expect(svc.getModelsByProvider('local-model')).toEqual([
      expect.objectContaining({
        id: 'lm://worker-node/node-win/ollama/ollama/qwen',
        provider: 'local-model',
        name: 'qwen on windows-pc',
        source: 'local-model',
        tier: 'balanced',
        family: 'Ollama',
        localModel: expect.objectContaining({
          healthy: true,
          loaded: false,
          endpointProvider: 'ollama',
          modelId: 'qwen',
          capabilities: expect.objectContaining({
            multiTurn: true,
            toolUse: 'none',
          }),
        }),
        discoveredAt: 1783468800000,
      }),
    ]);
  });

  it('replaces stale local model rows on refresh', () => {
    const svc = makeServiceWithMock();

    svc.onLocalModelInventoryRefreshed([{
      selectorId: 'lm://worker-node/node-win/ollama/ollama/old',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'old',
      displayName: 'old on windows-pc',
      healthy: true,
      loaded: false,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'none', vision: 'unknown' },
      discoveredAt: 1,
    }]);
    vi.runAllTimers();
    svc.onLocalModelInventoryRefreshed([]);
    vi.runAllTimers();

    expect(svc.getModelsByProvider('local-model')).toEqual([]);
  });

  it('publishes unhealthy local model rows as picker catalog metadata', () => {
    const svc = makeServiceWithMock();

    svc.onLocalModelInventoryRefreshed([{
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      displayName: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      healthy: false,
      loaded: false,
      capabilities: { streaming: true, multiTurn: true, toolUse: 'none', vision: 'unknown' },
      discoveredAt: 1783468800000,
    }]);
    vi.runAllTimers();

    expect(svc.getModelsByProvider('local-model')).toEqual([
      expect.objectContaining({
        id: 'lm://worker-node/node-win/ollama/ollama/qwen',
        provider: 'local-model',
        name: 'qwen on windows-pc',
        source: 'local-model',
        localModel: expect.objectContaining({
          healthy: false,
          loaded: false,
          modelId: 'qwen',
        }),
      }),
    ]);
  });
});

describe('UnifiedModelCatalogService — precedence: models.dev pricing overlay', () => {
  it('enriches static entries with pricing from the live overlay', () => {
    // Register a live rate for a known model
    registerModelRates({ sonnet: { input: 99, output: 199 } });

    const svc = makeServiceWithMock();

    const entry = svc.getModel('sonnet');
    expect(entry).toBeDefined();
    // The overlay rate should supersede the static MODEL_PRICING entry
    expect(entry!.pricing?.inputPerMillion).toBe(99);
    expect(entry!.pricing?.outputPerMillion).toBe(199);
  });

  it('enriches static entries with context windows from models.dev', () => {
    const svc = makeServiceWithMock({ sonnet: 500_000 });
    const entry = svc.getModel('sonnet');
    expect(entry!.contextWindow).toBe(500_000);
  });

  it('marks entry source as models-dev when context window was enriched', () => {
    const svc = makeServiceWithMock({ sonnet: 500_000 });
    const entry = svc.getModel('sonnet');
    expect(entry!.source).toBe('models-dev');
  });

  it('leaves source as static when neither overlay nor context window available', () => {
    const svc = makeServiceWithMock();
    // 'haiku' has static pricing in MODEL_PRICING — that's fine; the source
    // should remain 'static' since no live data was injected.
    const entry = svc.getModel('haiku');
    // haiku is in MODEL_PRICING, so pricing is present via static, source = static
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('static');
  });
});

describe('UnifiedModelCatalogService — precedence: CLI-discovered (highest)', () => {
  it('CLI-discovered entries supersede static entries for the same provider', () => {
    const svc = makeServiceWithMock();

    const liveModels: ModelDisplayInfo[] = [
      { id: 'brand-new-model', name: 'Brand New', tier: 'powerful' },
      { id: 'sonnet', name: 'Sonnet (live)', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    const liveEntry = svc.getModel('brand-new-model');
    expect(liveEntry).toBeDefined();
    expect(liveEntry!.source).toBe('cli-discovered');
    expect(liveEntry!.provider).toBe('claude');
    expect(liveEntry!.name).toBe('Brand New');

    const sonnetEntry = svc.getModel('sonnet');
    expect(sonnetEntry!.source).toBe('cli-discovered');
    expect(sonnetEntry!.name).toBe('Sonnet (live)');
  });

  it('overlays static tier when CLI entry has no tier', () => {
    const svc = makeServiceWithMock();

    // Simulate CLI returning a known model without a tier (not typical but
    // ModelDisplayInfo.tier is required; we test via the family overlay path)
    const liveModels: ModelDisplayInfo[] = [
      { id: 'opus', name: 'Opus (live)', tier: 'powerful' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('opus');
    expect(entry!.tier).toBe('powerful');
    // family comes from static catalog since CLI doesn't provide it on ModelDisplayInfo
    // when it's absent from the live entry
    expect(entry!.family).toBe('Opus');
  });

  it('overlays static family from curated catalog for known CLI-discovered id', () => {
    const svc = makeServiceWithMock();

    const liveModels: ModelDisplayInfo[] = [
      { id: 'claude-opus-4-8', name: 'Opus 4.8', tier: 'powerful' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('claude-opus-4-8');
    expect(entry!.family).toBe('Opus');
  });

  it('CLI-discovered entry gets pricing from the rate overlay', () => {
    registerModelRates({ 'brand-new-model': { input: 10, output: 30 } });
    const svc = makeServiceWithMock();

    const liveModels: ModelDisplayInfo[] = [
      { id: 'brand-new-model', name: 'Brand New', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('copilot', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('brand-new-model');
    expect(entry!.pricing?.inputPerMillion).toBe(10);
    expect(entry!.pricing?.outputPerMillion).toBe(30);
  });

  it('CLI-discovered entry gets contextWindow from models.dev mock', () => {
    const svc = makeServiceWithMock({ 'live-model': 300_000 });

    const liveModels: ModelDisplayInfo[] = [
      { id: 'live-model', name: 'Live Model', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('copilot', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('live-model');
    expect(entry!.contextWindow).toBe(300_000);
  });

  it('getModel returns the highest-priority source when an id appears under multiple providers', () => {
    const svc = makeServiceWithMock();

    svc.onCatalogOverrideChanged([{
      id: 'shared-model-id',
      provider: 'gemini',
      tier: 'balanced',
      origin: 'local',
      discoveredAt: 100,
      source: 'catalog-override',
    }]);
    svc.onCliDiscoveryRefreshed('claude', [
      { id: 'shared-model-id', name: 'Shared Live Model', tier: 'powerful' },
    ]);
    vi.runAllTimers();

    expect(svc.getModel('shared-model-id')).toMatchObject({
      provider: 'claude',
      source: 'cli-discovered',
      name: 'Shared Live Model',
    });
  });
});

describe('UnifiedModelCatalogService — precedence: user custom models', () => {
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  it('adds custom model ids as user-custom entries with custom provenance', () => {
    const svc = makeServiceWithMock({ 'claude-future-opus': 250_000 });

    svc.onCustomModelsChanged({
      claude: ['claude-future-opus'],
    });
    vi.runAllTimers();

    const entry = svc.getModel('claude-future-opus');
    expect(entry).toMatchObject({
      id: 'claude-future-opus',
      provider: 'claude',
      source: 'user-custom',
      isCustom: true,
      tier: 'balanced',
      contextWindow: 250_000,
    });
  });

  it('dedupes and trims custom ids, ignoring empty values', () => {
    const svc = makeServiceWithMock();

    svc.onCustomModelsChanged({
      gemini: ['  gemini-future-pro  ', '', 'gemini-future-pro'],
    });
    vi.runAllTimers();

    const matches = svc
      .getModelsByProvider('gemini')
      .filter((entry) => entry.id === 'gemini-future-pro');
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('user-custom');
    expect(matches[0].isCustom).toBe(true);
  });

  it('ignores custom ids beyond the dynamic catalog limit from corrupted settings', () => {
    const svc = makeServiceWithMock();

    expect(tooLongCatalogModelId).toHaveLength(513);

    svc.onCustomModelsChanged({
      claude: [tooLongCatalogModelId],
    });
    vi.runAllTimers();

    expect(svc.getModel(tooLongCatalogModelId)).toBeUndefined();
    expect(normalizeModelForProvider('claude', tooLongCatalogModelId)).not.toBe(tooLongCatalogModelId);
  });

  it('keeps CLI-discovered models above custom models for the same provider/id', () => {
    const svc = makeServiceWithMock();

    svc.onCustomModelsChanged({
      claude: ['claude-future-opus'],
    });
    svc.onCliDiscoveryRefreshed('claude', [
      { id: 'claude-future-opus', name: 'Live Future Opus', tier: 'powerful' },
    ]);
    vi.runAllTimers();

    const entry = svc.getModel('claude-future-opus');
    expect(entry).toMatchObject({
      source: 'cli-discovered',
      tier: 'powerful',
    });
    expect(entry!.isCustom).toBeUndefined();
  });

  it('emits catalog-updated when attached settings change customModelsByProvider', () => {
    const svc = makeServiceWithMock();
    const listener = vi.fn();
    const settings = new EventEmitter() as EventEmitter & {
      get: (key: string) => unknown;
    };
    settings.get = vi.fn(() => ({}));
    svc.attachSettingsManager(settings);
    vi.runAllTimers();
    listener.mockClear();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    settings.emit('setting-changed', 'customModelsByProvider', {
      codex: ['gpt-future-codex'],
    });
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      sources: ['user-custom'],
    });
    expect(svc.getModel('gpt-future-codex')).toMatchObject({
      provider: 'codex',
      source: 'user-custom',
      isCustom: true,
    });
  });

  it('seeds attached custom settings into normalization before the debounce timer fires', () => {
    const svc = makeServiceWithMock();
    const settings = new EventEmitter() as EventEmitter & {
      get: (key: string) => unknown;
    };
    settings.get = vi.fn(() => ({
      claude: ['claude-custom-startup-opus'],
    }));

    svc.attachSettingsManager(settings);

    expect(normalizeModelForProvider('claude', 'claude-custom-startup-opus')).toBe(
      'claude-custom-startup-opus',
    );
  });

  it('refreshes the shared normalization snapshot after custom models change', () => {
    const svc = makeServiceWithMock();

    svc.onCustomModelsChanged({
      claude: ['claude-future-opus'],
    });
    vi.runAllTimers();

    expect(normalizeModelForProvider('claude', 'claude-future-opus')).toBe('claude-future-opus');
  });
});

describe('UnifiedModelCatalogService — precedence: catalog overrides', () => {
  it('adds local override entries with catalog-override provenance and display names', () => {
    const svc = makeServiceWithMock({ 'claude-override-opus': 1_000_000 });

    svc.onCatalogOverrideChanged([{
      id: 'claude-override-opus',
      provider: 'claude',
      name: 'Override Opus',
      tier: 'powerful',
      family: 'Opus',
      pricing: { inputPerMillion: 12, outputPerMillion: 60 },
      contextWindow: 2_000_000,
      origin: 'local',
      discoveredAt: 123,
      source: 'catalog-override',
    }]);
    vi.runAllTimers();

    expect(svc.getModel('claude-override-opus')).toMatchObject({
      id: 'claude-override-opus',
      provider: 'claude',
      name: 'Override Opus',
      source: 'catalog-override',
      tier: 'powerful',
      family: 'Opus',
      pricing: { inputPerMillion: 12, outputPerMillion: 60 },
      pricingSource: 'catalog-override',
      contextWindow: 2_000_000,
      discoveredAt: 123,
    });
    expect(normalizeModelForProvider('claude', 'claude-override-opus')).toBe('claude-override-opus');
  });

  it('keeps custom models and CLI-discovered models above catalog overrides', () => {
    const svc = makeServiceWithMock();

    svc.onCatalogOverrideChanged([{
      id: 'claude-future-opus',
      provider: 'claude',
      tier: 'balanced',
      origin: 'remote',
      discoveredAt: 100,
      source: 'catalog-override',
    }]);
    svc.onCustomModelsChanged({
      claude: ['claude-future-opus'],
    });
    vi.runAllTimers();
    expect(svc.getModel('claude-future-opus')).toMatchObject({
      source: 'user-custom',
      isCustom: true,
    });

    svc.onCliDiscoveryRefreshed('claude', [
      { id: 'claude-future-opus', name: 'CLI Future Opus', tier: 'powerful' },
    ]);
    vi.runAllTimers();

    expect(svc.getModel('claude-future-opus')).toMatchObject({
      source: 'cli-discovered',
      tier: 'powerful',
    });
  });

  it('emits catalog-updated when an attached override source refreshes', () => {
    const svc = makeServiceWithMock();
    const source = new EventEmitter() as EventEmitter & {
      getEntries: () => unknown[];
    };
    source.getEntries = vi.fn(() => []);
    svc.attachCatalogOverrideSource(source);
    vi.runAllTimers();
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    source.getEntries = vi.fn(() => [{
      id: 'remote-gemini-pro',
      provider: 'gemini',
      origin: 'remote',
      discoveredAt: 999,
      source: 'catalog-override',
    }]);
    source.emit('updated');
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({
      sources: ['catalog-override'],
    });
    expect(svc.getModel('remote-gemini-pro')).toMatchObject({
      provider: 'gemini',
      source: 'catalog-override',
    });
  });

  it('seeds attached override entries into normalization before the debounce timer fires', () => {
    const svc = makeServiceWithMock();
    const source = new EventEmitter() as EventEmitter & {
      getEntries: () => unknown[];
    };
    source.getEntries = vi.fn(() => [{
      id: 'claude-local-opus',
      provider: 'claude',
      origin: 'local',
      discoveredAt: 999,
      source: 'catalog-override',
    }]);

    svc.attachCatalogOverrideSource(source);

    expect(normalizeModelForProvider('claude', 'claude-local-opus')).toBe('claude-local-opus');
  });
});

describe('UnifiedModelCatalogService — catalog-updated event', () => {
  it('emits catalog-updated after onModelsDevRefreshed (debounce flushed)', () => {
    const svc = makeServiceWithMock();
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    svc.onModelsDevRefreshed();
    expect(listener).not.toHaveBeenCalled(); // debounce pending

    vi.runAllTimers();
    expect(listener).toHaveBeenCalledOnce();
    const payload = listener.mock.calls[0][0] as CatalogUpdatedPayload;
    expect(payload.sources).toContain('models-dev');
    expect(payload.totalEntries).toBeGreaterThan(0);
  });

  it('emits catalog-updated after onCliDiscoveryRefreshed', () => {
    const svc = makeServiceWithMock();
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    svc.onCliDiscoveryRefreshed('cursor', [{ id: 'a', name: 'A', tier: 'fast' }]);
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledOnce();
    const payload = listener.mock.calls[0][0] as CatalogUpdatedPayload;
    expect(payload.sources).toContain('cli-discovered');
  });

  it('coalesces rapid refreshes from multiple sources into one event', () => {
    const svc = makeServiceWithMock();
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    svc.onModelsDevRefreshed();
    svc.onCliDiscoveryRefreshed('copilot', [{ id: 'x', name: 'X', tier: 'balanced' }]);
    svc.onModelsDevRefreshed(); // duplicate, same debounce window

    vi.runAllTimers();
    expect(listener).toHaveBeenCalledOnce();

    const payload = listener.mock.calls[0][0] as CatalogUpdatedPayload;
    expect(payload.sources).toContain('models-dev');
    expect(payload.sources).toContain('cli-discovered');
  });

  it('does NOT emit catalog-updated on the initial static build', () => {
    // The singleton builds from static data in the constructor; no event.
    const listener = vi.fn();
    const svc = UnifiedModelCatalogService.getInstance();
    svc.on(CATALOG_UPDATED_EVENT, listener);
    vi.runAllTimers();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('UnifiedModelCatalogService — getUnifiedModelCatalog convenience accessor', () => {
  it('returns the singleton', () => {
    const a = getUnifiedModelCatalog();
    const b = getUnifiedModelCatalog();
    expect(a).toBe(b);
  });
});

describe('UnifiedModelCatalogService — getAllModels after CLI refresh', () => {
  it('includes both static-only models and CLI-discovered models after refresh', () => {
    const svc = makeServiceWithMock();

    // Record initial claude count from static list
    const staticClaudeCount = svc.getModelsByProvider('claude').length;
    expect(staticClaudeCount).toBeGreaterThan(0);

    // CLI returns two models for claude — one overlapping, one new
    const liveModels: ModelDisplayInfo[] = [
      { id: 'sonnet', name: 'Sonnet (live)', tier: 'balanced', family: 'Sonnet' },
      { id: 'claude-future', name: 'Future Model', tier: 'powerful', family: 'Opus' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    // After refresh the CLI list *replaces* claude entries (only 2 live models)
    // since the rebuild re-layers from scratch.
    // Static entries for 'claude' that are NOT in the CLI list are removed
    // because CLI-discovered fully replaces the provider's entries.
    // However — static entries for other providers (codex, gemini…) remain.
    const allModels = svc.getAllModels();
    const futurModel = allModels.find((m) => m.id === 'claude-future');
    expect(futurModel).toBeDefined();
    expect(futurModel!.source).toBe('cli-discovered');

    // Non-claude providers should still have their static entries
    const geminiModels = svc.getModelsByProvider('gemini');
    expect(geminiModels.length).toBeGreaterThan(0);
  });

  it('treats same-provider static rows as fallback only after live CLI discovery succeeds', () => {
    const svc = makeServiceWithMock();
    expect(svc.getModel('opus[1m]')).toBeDefined();

    svc.onCliDiscoveryRefreshed('claude', [
      { id: 'claude-live-opus', name: 'Live Opus', tier: 'powerful', family: 'Opus' },
    ]);
    vi.runAllTimers();

    const claudeIds = svc.getModelsByProvider('claude').map((model) => model.id);
    expect(claudeIds).toEqual(['claude-live-opus']);
    expect(svc.getModel('opus[1m]')).toBeUndefined();

    const geminiModels = svc.getModelsByProvider('gemini');
    expect(geminiModels.length).toBeGreaterThan(0);
  });

  it('keeps static fallback rows when CLI discovery returns no models', () => {
    const svc = makeServiceWithMock();
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);
    const staticClaudeIds = svc.getModelsByProvider('claude').map((model) => model.id);
    expect(staticClaudeIds.length).toBeGreaterThan(0);

    svc.onCliDiscoveryRefreshed('claude', []);
    vi.runAllTimers();

    expect(svc.getModelsByProvider('claude').map((model) => model.id)).toEqual(staticClaudeIds);
    expect(svc.getCatalogStatus().cliDiscoveryLastRefreshedAt['claude']).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FIX 1: models.dev-only entry inclusion
// ---------------------------------------------------------------------------

describe('UnifiedModelCatalogService — FIX 1: models.dev-only entries included', () => {
  it('adds a models.dev entry whose id is NOT in the static catalog', () => {
    const devEntries: ModelsDevEntry[] = [
      {
        id: 'new-provider-model-xyz',
        provider: 'newprovider',
        rate: { input: 2, output: 8 },
        contextWindow: 128_000,
      },
    ];
    const svc = makeServiceWithMock({}, devEntries);

    const entry = svc.getModel('new-provider-model-xyz');
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('models-dev');
    expect(entry!.provider).toBe('newprovider');
    expect(entry!.pricing?.inputPerMillion).toBe(2);
    expect(entry!.pricing?.outputPerMillion).toBe(8);
    expect(entry!.contextWindow).toBe(128_000);
    expect(entry!.pricingSource).toBe('models-dev');
  });

  it('maps supported models.dev provider namespaces into app provider buckets', () => {
    const devEntries: ModelsDevEntry[] = [
      {
        id: 'claude-upstream-only-opus',
        provider: 'anthropic',
        rate: { input: 5, output: 25 },
        contextWindow: 1_000_000,
      },
    ];
    const svc = makeServiceWithMock({}, devEntries);

    const entry = svc.getModel('claude-upstream-only-opus');
    expect(entry).toBeDefined();
    expect(entry!.provider).toBe('claude');
    expect(entry!.source).toBe('models-dev');
    expect(svc.getModelsByProvider('claude').map((model) => model.id)).toContain(
      'claude-upstream-only-opus',
    );
    expect(normalizeModelForProvider('claude', 'claude-upstream-only-opus')).toBe(
      'claude-upstream-only-opus',
    );
  });

  it('does NOT add a models.dev entry whose id already exists in the static catalog', () => {
    const devEntries: ModelsDevEntry[] = [
      // 'sonnet' is in the claude static list — should NOT create a duplicate
      { id: 'sonnet', provider: 'anthropic', rate: { input: 99, output: 199 } },
    ];
    // Register the rate in the overlay so getModelRate returns it
    registerModelRates({ sonnet: { input: 99, output: 199 } });
    const svc = makeServiceWithMock({}, devEntries);

    // There should be exactly one entry for 'sonnet'
    const allModels = svc.getAllModels();
    const sonnetEntries = allModels.filter((m) => m.id === 'sonnet');
    expect(sonnetEntries).toHaveLength(1);
    // The surviving entry should be the static-origin one (upgraded to models-dev)
    expect(sonnetEntries[0].provider).toBe('claude');
  });

  it('models.dev-only entries appear in getAllModels()', () => {
    const devEntries: ModelsDevEntry[] = [
      { id: 'only-in-dev-a', provider: 'devprovider', rate: { input: 1, output: 4 } },
      { id: 'only-in-dev-b', provider: 'devprovider', rate: { input: 2, output: 8 } },
    ];
    const svc = makeServiceWithMock({}, devEntries);

    const all = svc.getAllModels();
    expect(all.some((m) => m.id === 'only-in-dev-a')).toBe(true);
    expect(all.some((m) => m.id === 'only-in-dev-b')).toBe(true);
  });

  it('emits catalog-updated with source models-dev when onModelsDevRefreshed rebuilds', () => {
    const devEntries: ModelsDevEntry[] = [
      { id: 'refresh-test-model', provider: 'testprov', rate: { input: 5, output: 10 } },
    ];
    const svc = makeServiceWithMock({}, devEntries);
    const listener = vi.fn();
    svc.on(CATALOG_UPDATED_EVENT, listener);

    svc.onModelsDevRefreshed();
    vi.runAllTimers();

    expect(listener).toHaveBeenCalledOnce();
    const payload = listener.mock.calls[0][0] as CatalogUpdatedPayload;
    expect(payload.sources).toContain('models-dev');
    // The new model should be in the rebuilt catalog
    const entry = svc.getModel('refresh-test-model');
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('models-dev');
  });
});

// ---------------------------------------------------------------------------
// FIX 2: Pricing attribution (pricingSource)
// ---------------------------------------------------------------------------

describe('UnifiedModelCatalogService — FIX 2: pricing attribution via pricingSource', () => {
  it('static-priced model has pricingSource=static when no overlay', () => {
    const svc = makeServiceWithMock();
    // 'sonnet' has a static entry in MODEL_PRICING
    const entry = svc.getModel('sonnet');
    expect(entry).toBeDefined();
    expect(entry!.pricingSource).toBe('static');
  });

  it('static model that gets a models.dev overlay has pricingSource=models-dev', () => {
    // Register a live rate for a model that also has a static price
    registerModelRates({ sonnet: { input: 77, output: 177 } });
    const svc = makeServiceWithMock();

    const entry = svc.getModel('sonnet');
    expect(entry).toBeDefined();
    // The overlay price should have won
    expect(entry!.pricing?.inputPerMillion).toBe(77);
    expect(entry!.pricing?.outputPerMillion).toBe(177);
    // And pricingSource reflects the winning source
    expect(entry!.pricingSource).toBe('models-dev');
  });

  it('models-dev-only entry has pricingSource=models-dev', () => {
    const devEntries: ModelsDevEntry[] = [
      { id: 'models-dev-only', provider: 'someprov', rate: { input: 3, output: 12 } },
    ];
    const svc = makeServiceWithMock({}, devEntries);
    const entry = svc.getModel('models-dev-only');
    expect(entry!.pricingSource).toBe('models-dev');
  });

  it('CLI-discovered entry with static pricing has pricingSource=static', () => {
    // 'sonnet' is in static MODEL_PRICING with no overlay
    const svc = makeServiceWithMock();
    const liveModels: ModelDisplayInfo[] = [
      { id: 'sonnet', name: 'Sonnet (live)', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('sonnet');
    expect(entry!.source).toBe('cli-discovered');
    expect(entry!.pricingSource).toBe('static');
  });

  it('CLI-discovered entry with models.dev overlay has pricingSource=models-dev', () => {
    registerModelRates({ sonnet: { input: 55, output: 155 } });
    const svc = makeServiceWithMock();
    const liveModels: ModelDisplayInfo[] = [
      { id: 'sonnet', name: 'Sonnet (live)', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('claude', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('sonnet');
    expect(entry!.source).toBe('cli-discovered');
    expect(entry!.pricing?.inputPerMillion).toBe(55);
    expect(entry!.pricingSource).toBe('models-dev');
  });

  it('entry without any known pricing has pricingSource=undefined', () => {
    const devEntries: ModelsDevEntry[] = [
      // A models.dev-only model with no rate won't be added; we verify via CLI discovery
    ];
    const svc = makeServiceWithMock({}, devEntries);
    // Push a CLI model with no known pricing
    const liveModels: ModelDisplayInfo[] = [
      { id: 'totally-unknown-no-price', name: 'Unknown', tier: 'balanced' },
    ];
    svc.onCliDiscoveryRefreshed('copilot', liveModels);
    vi.runAllTimers();

    const entry = svc.getModel('totally-unknown-no-price');
    expect(entry).toBeDefined();
    expect(entry!.pricing).toBeUndefined();
    expect(entry!.pricingSource).toBeUndefined();
  });
});
