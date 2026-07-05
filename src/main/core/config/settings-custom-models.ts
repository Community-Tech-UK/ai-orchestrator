import type { AppSettings } from '../../../shared/types/settings.types';
import { MAX_MODEL_ID_LENGTH } from '../../../shared/types/provider.types';

const CONCRETE_CLI_PROVIDERS = new Set([
  'claude',
  'gemini',
  'antigravity',
  'codex',
  'copilot',
  'cursor',
]);

interface LegacyCustomModelOverrideMigrationDeps {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  persist<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  logMigrated(provider: string, modelId: string): void;
}

export function migrateLegacyCustomModelOverride(
  deps: LegacyCustomModelOverrideMigrationDeps,
): void {
  const legacy = deps.get('customModelOverride');
  if (typeof legacy !== 'string' || legacy.trim().length === 0) {
    return;
  }

  const provider = deps.get('defaultCli');
  if (typeof provider !== 'string' || !CONCRETE_CLI_PROVIDERS.has(provider)) {
    return;
  }

  const modelId = legacy.trim();
  if (modelId.length > MAX_MODEL_ID_LENGTH) {
    return;
  }

  const existing = sanitizeCustomModelsByProvider(deps.get('customModelsByProvider'));
  const providerModels = existing[provider] ?? [];
  const nextProviderModels = providerModels.includes(modelId)
    ? providerModels
    : [...providerModels, modelId];

  deps.logMigrated(provider, modelId);
  deps.persist('customModelsByProvider', {
    ...existing,
    [provider]: nextProviderModels,
  });
  deps.persist('customModelOverride', '');
}

function sanitizeCustomModelsByProvider(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [provider, rawModels] of Object.entries(value)) {
    if (!Array.isArray(rawModels)) {
      continue;
    }
    const models = uniqueNonEmptyStrings(rawModels);
    if (models.length > 0) {
      result[provider.trim().toLowerCase()] = models;
    }
  }
  return result;
}

function uniqueNonEmptyStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim();
    if (!value || value.length > MAX_MODEL_ID_LENGTH || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
