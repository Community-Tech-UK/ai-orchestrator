import { describe, it, expect } from 'vitest';
import {
  MODEL_CATALOG,
  getModelCatalogEntry,
  getModelsForProvider,
  getModelsWithInputModality,
  estimatePromptCost,
} from './models-catalog';
import { PROVIDER_MODEL_LIST } from '../types/provider.types';

const CATALOG_PROVIDER_BY_STATIC_PROVIDER = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
} as const;

describe('models-catalog', () => {
  it('keeps active first-party catalog IDs in sync with PROVIDER_MODEL_LIST', () => {
    for (const [staticProvider, catalogProvider] of Object.entries(CATALOG_PROVIDER_BY_STATIC_PROVIDER)) {
      const expected = (PROVIDER_MODEL_LIST[staticProvider] ?? []).map((model) => model.id);
      const active = getModelsForProvider(catalogProvider).map((model) => model.id);

      expect(active, `${catalogProvider} active catalog ids`).toEqual(expected);
    }
  });

  it('catalog has at least one active model per major provider', () => {
    for (const provider of ['anthropic', 'google', 'openai'] as const) {
      expect(getModelsForProvider(provider).length).toBeGreaterThan(0);
    }
  });

  it('every entry has required fields', () => {
    for (const entry of MODEL_CATALOG) {
      expect(entry.id).toBeTruthy();
      expect(entry.name).toBeTruthy();
      expect(entry.contextWindow).toBeGreaterThan(0);
      expect(entry.maxOutputTokens).toBeGreaterThan(0);
      expect(entry.inputModalities.length).toBeGreaterThan(0);
    }
  });

  it('getModelCatalogEntry returns undefined for unknown IDs', () => {
    expect(getModelCatalogEntry('not-a-real-model')).toBeUndefined();
  });

  it('getModelCatalogEntry returns entry for known IDs', () => {
    const entry = getModelCatalogEntry('claude-sonnet-4-6-20260401');
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe('anthropic');
  });

  it('getModelsWithInputModality returns vision-capable models', () => {
    const visionModels = getModelsWithInputModality('image');
    expect(visionModels.length).toBeGreaterThan(0);
    for (const m of visionModels) {
      expect(m.inputModalities).toContain('image');
    }
  });

  it('estimatePromptCost returns a number for known models with pricing', () => {
    const cost = estimatePromptCost('claude-sonnet-4-6-20260401', 1_000_000, 500_000);
    expect(typeof cost).toBe('number');
    expect(cost).toBeGreaterThan(0);
  });

  it('estimatePromptCost returns undefined for unknown model IDs', () => {
    expect(estimatePromptCost('unknown-model', 1000, 500)).toBeUndefined();
  });

  it('claude-sonnet-4-6-20260401 has current generated metadata and pricing', () => {
    const m = getModelCatalogEntry('claude-sonnet-4-6-20260401')!;
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.capabilities.promptCaching).toBe(true);
    expect(m.pricing?.inputPer1mTokens).toBe(3.0);
  });

  it('claude-opus-4-8 is active with 1M context and current pricing', () => {
    const m = getModelCatalogEntry('claude-opus-4-8')!;
    expect(m.name).toBe('Opus 4.8');
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxOutputTokens).toBe(128_000);
    expect(m.capabilities.promptCaching).toBe(true);
    expect(m.pricing?.inputPer1mTokens).toBe(5.0);
    expect(m.pricing?.outputPer1mTokens).toBe(25.0);
    expect(m.active).toBe(true);
  });

  it('claude-fable-5 is active with documented limits and pricing', () => {
    const m = getModelCatalogEntry('claude-fable-5')!;
    expect(m.name).toBe('Fable 5');
    expect(m.contextWindow).toBe(1_000_000);
    expect(m.maxOutputTokens).toBe(128_000);
    expect(m.capabilities.promptCaching).toBe(true);
    expect(m.capabilities.reasoning).toBe(true);
    expect(m.pricing?.inputPer1mTokens).toBe(10.0);
    expect(m.pricing?.outputPer1mTokens).toBe(50.0);
    expect(m.active).toBe(true);
  });
});
