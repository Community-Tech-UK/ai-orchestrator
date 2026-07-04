export interface KnownProviderModelId {
  provider: string;
  id: string;
}

let knownModelCatalogIdsByProvider = new Map<string, Set<string>>();

/**
 * Replace the process-local live catalog snapshot used by synchronous model
 * normalization. Main and renderer populate their own copy from the unified
 * catalog because shared code cannot import the Electron-only catalog service.
 */
export function replaceKnownModelCatalogSnapshot(
  entries: Iterable<KnownProviderModelId>,
): void {
  const next = new Map<string, Set<string>>();

  for (const entry of entries) {
    addKnownModelId(next, entry);
  }

  knownModelCatalogIdsByProvider = next;
}

export function mergeKnownModelCatalogSnapshot(
  entries: Iterable<KnownProviderModelId>,
): void {
  const next = new Map(
    Array.from(knownModelCatalogIdsByProvider.entries()).map(
      ([provider, ids]) => [provider, new Set(ids)] as const,
    ),
  );

  for (const entry of entries) {
    addKnownModelId(next, entry);
  }

  knownModelCatalogIdsByProvider = next;
}

export function clearKnownModelCatalogSnapshotForTesting(): void {
  knownModelCatalogIdsByProvider = new Map<string, Set<string>>();
}

export function getKnownCatalogModelIdsForProvider(provider: string): string[] {
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  return Array.from(knownModelCatalogIdsByProvider.get(normalizedProvider) ?? []);
}

export function isKnownCatalogModelForProvider(
  provider: string,
  modelId?: string | null,
): boolean {
  const id = modelId?.trim();
  if (!id) return false;
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  return knownModelCatalogIdsByProvider.get(normalizedProvider)?.has(id) === true;
}

function addKnownModelId(
  target: Map<string, Set<string>>,
  entry: KnownProviderModelId,
): void {
  const provider = normalizeProviderModelNamespace(entry.provider);
  const id = entry.id.trim();
  if (!provider || !id) return;
  const ids = target.get(provider) ?? new Set<string>();
  ids.add(id);
  target.set(provider, ids);
}

function normalizeProviderModelNamespace(provider: string): string {
  const normalized = provider.trim().toLowerCase();

  switch (normalized) {
    case 'claude-cli':
    case 'anthropic-api':
      return 'claude';
    case 'openai':
    case 'openai-compatible':
      return 'codex';
    case 'google':
      return 'gemini';
    default:
      return normalized;
  }
}
