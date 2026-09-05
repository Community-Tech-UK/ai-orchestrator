import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelCatalogService } from '../unified-model-catalog-service';
import type { ModelDisplayInfo } from '../../../shared/types/provider.types';

beforeEach(() => {
  UnifiedModelCatalogService._resetForTesting();
  vi.useFakeTimers();
});
afterEach(() => {
  UnifiedModelCatalogService._resetForTesting();
  vi.useRealTimers();
});

it('carries and replaces CLI reasoning capabilities in the unified catalog', () => {
  const catalog = UnifiedModelCatalogService.getInstance();
  const model: ModelDisplayInfo = { id: 'gpt-6-astra', name: 'Astra', tier: 'powerful',
    reasoning: { supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
  };
  catalog.onCliDiscoveryRefreshed('codex', [model]);
  vi.runAllTimers();
  expect(catalog.getModel(model.id)?.reasoning).toEqual(model.reasoning);

  const refreshed: ModelDisplayInfo = { ...model,
    reasoning: { supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
  };
  catalog.onCliDiscoveryRefreshed('codex', [refreshed]);
  vi.runAllTimers();
  expect(catalog.getModel(model.id)?.reasoning).toEqual(refreshed.reasoning);

  catalog.onCliDiscoveryRefreshed('codex', [{ id: model.id, name: model.name, tier: model.tier }]);
  vi.runAllTimers();
  expect(catalog.getModel(model.id)?.reasoning).toBeUndefined();
});
