/**
 * Derived model-resolution helpers.
 *
 * Split out of provider.types.ts to keep that module focused on the type
 * definitions and the static model catalog. These are pure functions that read
 * the catalog constants (imported from provider.types) and resolve/normalize
 * model ids for a provider. provider.types re-exports them so existing import
 * sites keep working; the import cycle is safe because nothing here touches the
 * catalog constants at module-evaluation time (only inside function bodies).
 */
import {
  DEFAULT_MODELS,
  MAX_MODEL_ID_LENGTH,
  PROVIDER_MODEL_LIST,
  type ModelDisplayInfo,
  type ProviderType,
} from './provider.types';
import { isKnownCatalogModelForProvider } from './provider-model-catalog-snapshot';

/**
 * Get available models for a given CLI provider.
 */
export function getModelsForProvider(provider: string): ModelDisplayInfo[] {
  return PROVIDER_MODEL_LIST[provider] ?? [];
}

/**
 * True when `modelId` is a known Antigravity (`agy`) model — an exact display
 * label from `agy models` present in PROVIDER_MODEL_LIST.antigravity. The
 * adapter gates `--model` forwarding on this so stale ids (a `gemini-*` id, a
 * tier name, etc.) are dropped and agy uses its default rather than a bogus value.
 */
export function isAntigravityModelId(modelId?: string | null): boolean {
  const trimmed = modelId?.trim();
  if (!trimmed) return false;
  return (PROVIDER_MODEL_LIST['antigravity'] ?? []).some((model) => model.id === trimmed)
    || isKnownCatalogModelForProvider('antigravity', trimmed);
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

function modelAliasKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bpreview\b/g, '')
    .replace(/\blatest\b/g, '')
    .replace(/\blet\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize a human-readable model name to the provider's canonical model ID.
 *
 * Unknown dynamic model IDs intentionally pass through unchanged, which keeps
 * fast-moving providers like Copilot and Cursor usable before the static list is
 * updated.
 */
export function normalizeModelAliasForProvider(
  provider: string,
  modelId?: string | null
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalizedProvider = normalizeProviderModelNamespace(provider);
  const providerModels = getModelsForProvider(normalizedProvider);
  const exact = providerModels.find((model) => model.id === trimmed);
  if (exact) {
    return exact.id;
  }

  const requestedKey = modelAliasKey(trimmed);
  const matched = providerModels.find((model) => {
    const idKey = modelAliasKey(model.id);
    const nameKey = modelAliasKey(model.name);
    return requestedKey === idKey || requestedKey === nameKey;
  });

  return matched?.id ?? trimmed;
}

/**
 * Return the preferred UI/default model for a provider.
 * Prefers the first model in the static provider list, then falls back to the
 * provider's configured CLI default when the list is empty.
 */
export function getPrimaryModelForProvider(provider: string): string | undefined {
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  return getModelsForProvider(normalizedProvider)[0]?.id ?? getDefaultModelForCli(normalizedProvider);
}

/**
 * Normalize a model selection so stale cross-provider values do not leak into
 * a different CLI.
 *
 * Strict providers (Claude, Gemini, Antigravity) accept static or live-catalog
 * model ids.
 * Codex accepts any OpenAI/Codex-style model id because its list evolves
 * faster than our static allowlist.
 * Dynamic providers (Copilot, Cursor, Auto) preserve explicit non-empty ids.
 */
export function normalizeModelForProvider(
  provider: string,
  modelId?: string | null,
  fallbackModel?: string
): string | undefined {
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  const normalizedModel = normalizeModelAliasForProvider(normalizedProvider, modelId);
  const fallback = fallbackModel && fallbackModel.length <= MAX_MODEL_ID_LENGTH
    ? fallbackModel
    : getPrimaryModelForProvider(normalizedProvider);

  if (!normalizedModel) {
    return fallback;
  }
  if (normalizedModel.length > MAX_MODEL_ID_LENGTH) {
    return fallback;
  }

  const tierCandidate = normalizedModel.toLowerCase();
  if (isModelTier(tierCandidate)) {
    return resolveModelForTier(tierCandidate, normalizedProvider) ?? fallback;
  }

  switch (normalizedProvider) {
    case 'claude':
    case 'gemini':
    case 'antigravity': {
      // Antigravity is validated against its static label list like the other
      // fixed-catalog providers: agy accepts only the exact display labels, and
      // a stale cross-provider id (e.g. a legacy `gemini-*` id inherited when a
      // Gemini instance is normalized to antigravity) must fall back to the
      // default rather than be forwarded as a bogus --model value.
      const providerModels = getModelsForProvider(normalizedProvider);
      return providerModels.some((model) => model.id === normalizedModel)
        || isKnownCatalogModelForProvider(normalizedProvider, normalizedModel)
        ? normalizedModel
        : fallback;
    }
    case 'codex':
      return looksLikeCodexModelId(normalizedModel)
        || isKnownCatalogModelForProvider(normalizedProvider, normalizedModel)
        ? normalizedModel
        : fallback;
    default:
      return normalizedModel;
  }
}

/**
 * Codex/OpenAI CLI models change frequently. Accept broadly valid OpenAI-style
 * model ids instead of rejecting them against a stale static allowlist.
 */
export function looksLikeCodexModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return /^(gpt|o[1-9]|codex)([.-][a-z0-9]+)*$/i.test(normalized);
}

/**
 * Model tier names that can be used as shorthand in spawn commands.
 */
const MODEL_TIERS = new Set(['fast', 'balanced', 'powerful']);

/**
 * Check if a string is a model tier name rather than a concrete model ID.
 */
export function isModelTier(value: string): value is 'fast' | 'balanced' | 'powerful' {
  return MODEL_TIERS.has(value);
}

/**
 * Resolve a model tier name to a concrete model ID for a given provider.
 * Returns the first matching model for the tier, or undefined if no match.
 */
export function resolveModelForTier(
  tier: 'fast' | 'balanced' | 'powerful',
  provider: string
): string | undefined {
  const models = PROVIDER_MODEL_LIST[provider];
  if (!models || models.length === 0) return undefined;
  const match = models.find(m => m.tier === tier);
  return match?.id;
}

/**
 * Get short display name for a model ID (for badges).
 */
export function getModelShortName(modelId: string, provider: string): string {
  const models = PROVIDER_MODEL_LIST[provider];
  if (models) {
    const match = models.find(m => m.id === modelId);
    if (match) return match.name;
  }
  return modelId.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-/g, ' ');
}

/**
 * Maps CLI type identifiers to ProviderType keys used in DEFAULT_MODELS.
 * Mirrors the mapping in default-invokers.ts but exposed for shared use.
 */
const CLI_TO_PROVIDER_TYPE: Record<string, ProviderType> = {
  claude: 'claude-cli',
  codex: 'openai',
  gemini: 'google',
  copilot: 'copilot',
  ollama: 'ollama',
  cursor: 'cursor',
  grok: 'grok',
};

/**
 * Get the default model for a CLI type.
 * Uses DEFAULT_MODELS to ensure the CLI always gets an explicit model
 * rather than falling back to its own (potentially outdated) built-in default.
 */
export function getDefaultModelForCli(cliType: string): string | undefined {
  const providerType = CLI_TO_PROVIDER_TYPE[cliType];
  return providerType ? DEFAULT_MODELS[providerType] : undefined;
}
