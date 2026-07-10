/**
 * Pure normalizers/helpers for the unified model catalog service.
 *
 * Split out of unified-model-catalog-service.ts to keep the service focused on
 * source coordination and event emission. These validate and normalize catalog
 * inputs (custom models, override entries, provider namespaces) and build the
 * static-model lookup. All are stateless (the static-model cache is passed in).
 */
import {
  PROVIDER_MODEL_LIST,
  MAX_MODEL_ID_LENGTH,
  type ModelDisplayInfo,
} from '../../shared/types/provider.types';
import type { CatalogOverrideEntry } from './catalog-override-source';

/** Stable key for the internal catalog map: `<provider>:<id>`. */
export function catalogKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export function normalizeCustomModelsByProvider(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [rawProvider, rawModels] of Object.entries(value)) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider || !Array.isArray(rawModels)) {
      continue;
    }

    const seen = new Set<string>();
    const models: string[] = [];
    for (const rawModel of rawModels) {
      if (typeof rawModel !== 'string') {
        continue;
      }
      const model = rawModel.trim();
      if (!model || model.length > MAX_MODEL_ID_LENGTH || seen.has(model)) {
        continue;
      }
      seen.add(model);
      models.push(model);
    }
    if (models.length > 0) {
      result[provider] = models;
    }
  }
  return result;
}

export function normalizeCatalogOverrideEntries(entries: CatalogOverrideEntry[]): CatalogOverrideEntry[] {
  const result = new Map<string, CatalogOverrideEntry>();
  for (const entry of entries) {
    const provider = entry.provider.trim().toLowerCase();
    const id = entry.id.trim();
    if (!provider || !id || entry.source !== 'catalog-override') {
      continue;
    }
    result.set(catalogKey(provider, id), {
      ...entry,
      provider,
      id,
      ...(entry.name ? { name: entry.name.trim() } : {}),
      ...(entry.family ? { family: entry.family.trim() } : {}),
    });
  }
  return Array.from(result.values());
}

export function getStaticModelsById(
  provider: string,
  cache: Map<string, Map<string, ModelDisplayInfo>>,
): Map<string, ModelDisplayInfo> {
  const cached = cache.get(provider);
  if (cached) {
    return cached;
  }
  const byId = new Map((PROVIDER_MODEL_LIST[provider] ?? []).map((model) => [model.id, model]));
  cache.set(provider, byId);
  return byId;
}

export function normalizeModelsDevProviderNamespace(provider: string): string {
  const normalized = provider.trim().toLowerCase();

  switch (normalized) {
    case 'anthropic':
      return 'claude';
    case 'google':
      return 'gemini';
    case 'openai':
      return 'codex';
    case 'github-copilot':
      return 'copilot';
    default:
      return normalized;
  }
}
