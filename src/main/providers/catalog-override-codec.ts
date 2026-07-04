import { z } from 'zod';
import type { CatalogSource, UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';

export const CATALOG_OVERRIDE_FILE_NAME = 'models-override.json';
export const MAX_OVERRIDE_BYTES = 2 * 1024 * 1024;

export type CatalogOverrideOrigin = 'local' | 'remote';

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

export function buildLocalOverrideEntry(
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

export function catalogOverrideKey(entry: Pick<CatalogOverrideEntry, 'provider' | 'id'>): string {
  return `${entry.provider}:${entry.id}`;
}

export function entriesToProviderMap(entries: CatalogOverrideEntry[]): Map<string, CatalogOverrideEntry[]> {
  const result = new Map<string, CatalogOverrideEntry[]>();
  for (const entry of entries) {
    const current = result.get(entry.provider) ?? [];
    result.set(entry.provider, [...current, entry]);
  }
  return result;
}

export function providerMapToEntries(entriesByProvider: Map<string, CatalogOverrideEntry[]>): CatalogOverrideEntry[] {
  return Array.from(entriesByProvider.values()).flat();
}

export function serializeLocalOverrideEntries(entries: CatalogOverrideEntry[]): string {
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

export function sameEntries(a: CatalogOverrideEntry[], b: CatalogOverrideEntry[]): boolean {
  return JSON.stringify(normalizeEntriesForComparison(a)) === JSON.stringify(normalizeEntriesForComparison(b));
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

function normalizeEntriesForComparison(
  entries: CatalogOverrideEntry[],
): Omit<CatalogOverrideEntry, 'discoveredAt'>[] {
  return [...entries]
    .sort((left, right) => catalogOverrideKey(left).localeCompare(catalogOverrideKey(right)))
    .map(toComparableEntry);
}

function toComparableEntry(entry: CatalogOverrideEntry): Omit<CatalogOverrideEntry, 'discoveredAt'> {
  return {
    id: entry.id,
    provider: entry.provider,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.tier !== undefined ? { tier: entry.tier } : {}),
    ...(entry.family !== undefined ? { family: entry.family } : {}),
    ...(entry.pricing !== undefined ? { pricing: entry.pricing } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
    source: entry.source,
    origin: entry.origin,
  };
}
