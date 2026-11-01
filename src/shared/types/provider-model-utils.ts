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
  PROVIDER_MODEL_REPLACEMENTS,
  PROVIDER_MODEL_LIST,
  type ModelDisplayInfo,
  type ProviderType,
} from './provider.types';
import {
  getKnownCatalogModelIdsForProvider,
  getPinnedCatalogModelId,
  hasFullModelCatalogSnapshot,
  isKnownCatalogModelForProvider,
} from './provider-model-catalog-snapshot';

/**
 * Get available models for a given CLI provider.
 */
export function getModelsForProvider(provider: string): ModelDisplayInfo[] {
  return PROVIDER_MODEL_LIST[provider] ?? [];
}

/**
 * The agy labels AIO may forward to `agy --model`. Once a whole catalog has
 * been published it is the only authority: the main catalog seeds it with the
 * static list, then `agy models` discovery replaces those rows, and agy exits 1
 * on a label it no longer lists, so a static row the live list dropped must not
 * be forwarded. Until then (worker agent, renderer before its first catalog
 * load, when it has merged only a few remembered ids) the static list stands
 * in, plus whatever was merged.
 */
function knownAntigravityModelIds(): string[] {
  const catalogIds = getKnownCatalogModelIdsForProvider('antigravity');
  if (hasFullModelCatalogSnapshot() && catalogIds.length > 0) return catalogIds;
  const staticIds = (PROVIDER_MODEL_LIST['antigravity'] ?? []).map((model) => model.id);
  return [...new Set([...staticIds, ...catalogIds])];
}

/**
 * True when `modelId` is an Antigravity (`agy`) label agy currently accepts.
 * The adapter gates `--model` forwarding on this so a stale id (a `gemini-*`
 * id, a tier name, a label agy has retired) is dropped and agy uses its own
 * default rather than failing the turn.
 */
export function isAntigravityModelId(modelId?: string | null): boolean {
  const trimmed = modelId?.trim();
  if (!trimmed) return false;
  return knownAntigravityModelIds().includes(trimmed);
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
 * Resolve an explicitly retired model id to its canonical replacement.
 *
 * Replacement chains are supported so persisted records can skip multiple
 * generations. A malformed cyclic declaration fails safe by returning the
 * original id instead of choosing an arbitrary point in the cycle.
 */
export function resolveModelReplacementForProvider(
  provider: string,
  modelId?: string | null,
  replacements: Readonly<Record<string, Readonly<Record<string, string>>>> = PROVIDER_MODEL_REPLACEMENTS,
): string | undefined {
  const original = modelId?.trim();
  if (!original) return undefined;

  const replacementRegistry: unknown = replacements;
  if (
    !replacementRegistry
    || typeof replacementRegistry !== 'object'
    || Array.isArray(replacementRegistry)
  ) {
    return original;
  }
  const replacementRecord = replacementRegistry as Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  const providerKey = normalizeProviderModelNamespace(provider);
  const providerCandidate: unknown = Object.prototype.hasOwnProperty.call(replacementRecord, providerKey)
    ? replacementRecord[providerKey]
    : undefined;
  const providerReplacements = providerCandidate
    && typeof providerCandidate === 'object'
    && !Array.isArray(providerCandidate)
    ? providerCandidate as Readonly<Record<string, string>>
    : undefined;
  let current = original;
  const visited = new Set<string>([current]);
  while (
    providerReplacements
    && Object.prototype.hasOwnProperty.call(providerReplacements, current)
  ) {
    const rawNext: unknown = providerReplacements[current];
    if (typeof rawNext !== 'string') return original;
    const next = rawNext.trim();
    if (!next || visited.has(next)) return original;
    visited.add(next);
    current = next;
  }
  return current;
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
  const resolvedReplacement = resolveModelReplacementForProvider(normalizedProvider, trimmed);
  if (!resolvedReplacement) return undefined;
  const providerModels = getModelsForProvider(normalizedProvider);
  const exact = providerModels.find((model) => model.id === resolvedReplacement);
  if (exact) {
    return exact.id;
  }

  const requestedKey = modelAliasKey(resolvedReplacement);
  const matched = providerModels.find((model) => {
    const idKey = modelAliasKey(model.id);
    const nameKey = modelAliasKey(model.name);
    return requestedKey === idKey || requestedKey === nameKey;
  });

  return matched?.id ?? resolvedReplacement;
}

/**
 * Return the preferred UI/default model for a provider.
 * Prefers the first model in the static provider list, then falls back to the
 * provider's configured CLI default when the list is empty.
 */
export function getPrimaryModelForProvider(provider: string): string | undefined {
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  // Grok's and Antigravity's installed CLIs are the source of truth for
  // "current". Once discovery has pinned a row into the live catalog (Grok's
  // `(default)` row, Antigravity's first `(Medium)` row), that id is the
  // primary so a new release is what new sessions and retired-id repair spawn.
  // Before discovery, the static list's first row remains the offline fallback.
  if (normalizedProvider === 'grok' || normalizedProvider === 'antigravity') {
    const liveDefault = getPinnedCatalogModelId(normalizedProvider);
    if (liveDefault) return liveDefault;
  }
  return getModelsForProvider(normalizedProvider)[0]?.id ?? getDefaultModelForCli(normalizedProvider);
}

/**
 * Normalize a model selection so stale cross-provider values do not leak into
 * a different CLI.
 *
 * Strict providers (Claude, Gemini, Grok) accept static or live-catalog model
 * ids; Antigravity accepts only labels agy currently lists.
 * Codex accepts any OpenAI/Codex-style model id because its list evolves
 * faster than our static allowlist.
 * Dynamic providers (Copilot, Cursor, Auto) preserve explicit non-empty ids.
 * OpenCode keeps `provider/model` ids verbatim (they depend on which backends
 * the user connected) and drops anything else, so a stale cross-provider id
 * such as `sonnet` falls back to OpenCode's own default instead of being sent.
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
    case 'gemini': {
      const providerModels = getModelsForProvider(normalizedProvider);
      return providerModels.some((model) => model.id === normalizedModel)
        || isKnownCatalogModelForProvider(normalizedProvider, normalizedModel)
        ? normalizedModel
        : fallback;
    }
    case 'antigravity':
      // agy exits 1 on a label it does not list, so a stale cross-provider id
      // (a legacy `gemini-*` id inherited when a Gemini instance is normalized
      // to antigravity) or a label agy has since dropped falls back to the
      // default. Retired labels with a known successor were already mapped by
      // normalizeModelAliasForProvider above.
      return isAntigravityModelId(normalizedModel) ? normalizedModel : fallback;
    case 'codex':
      return looksLikeCodexModelId(normalizedModel)
        || isKnownCatalogModelForProvider(normalizedProvider, normalizedModel)
        ? normalizedModel
        : fallback;
    case 'grok': {
      // Validated like the fixed-catalog providers above, for a blunter reason:
      // `grok agent -m <unknown id>` does not fall back, it exits 1 with
      // "unknown model id" and the session never starts. A stored selection xAI
      // has since retired (`grok-4.5`) must resolve to the current default
      // rather than be forwarded verbatim. The live `grok models` list feeds the
      // catalog snapshot, so a newly released id is accepted as soon as
      // discovery sees it, with no code edit. `auto` is kept as-is: the adapter
      // reads it as "omit -m and let the CLI choose".
      if (normalizedModel.toLowerCase() === GROK_AUTO_MODEL_ID) {
        return normalizedModel;
      }
      const providerModels = getModelsForProvider(normalizedProvider);
      return providerModels.some((model) => model.id === normalizedModel)
        || isKnownCatalogModelForProvider(normalizedProvider, normalizedModel)
        ? normalizedModel
        : fallback;
    }
    case 'opencode':
      return normalizedModel.includes('/') ? normalizedModel : fallback;
    default:
      return normalizedModel;
  }
}

/**
 * Whether a model id may be accepted without appearing in the catalog because
 * the provider's own model list moves faster than ours. Codex: any
 * OpenAI-style id. OpenCode: any `provider/model` id, since OpenCode validates
 * it against the session's own options and warns instead of failing, and its
 * catalog rows can lag the CLI (a fresh OpenCode home first lists its bundled
 * models.dev snapshot).
 */
export function isDynamicProviderModelId(provider: string, modelId: string): boolean {
  const normalizedProvider = normalizeProviderModelNamespace(provider);
  if (normalizedProvider === 'codex') return looksLikeCodexModelId(modelId);
  if (normalizedProvider === 'opencode') return modelId.includes('/');
  return false;
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
 * Grok's "let the CLI choose" sentinel. `createGrokAdapter` omits `-m` entirely
 * for this value, so it must survive normalization rather than resolve to a
 * concrete id.
 */
const GROK_AUTO_MODEL_ID = 'auto';

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
  // agy lists Flash as High, Medium, Low, so the first balanced row would be
  // `Flash (High)`. Balanced means the house default (`Flash (Medium)`), which
  // also tracks the live list.
  if (provider === 'antigravity' && tier === 'balanced') return antigravityDefaultModel();
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
  // Maps to no DEFAULT_MODELS row on purpose: OpenCode picks its own default.
  opencode: 'opencode',
};

/** The newest Gemini Flash at Medium effort, e.g. `Gemini 3.8 Flash (Medium)`. */
const ANTIGRAVITY_HOUSE_DEFAULT_PATTERN = /^Gemini (\d+(?:\.\d+)*) Flash \(Medium\)$/;

/**
 * T41 — Antigravity's house default.
 *
 * `antigravity` is a CLI-only provider with no `ProviderType` member, so it had
 * no `CLI_TO_PROVIDER_TYPE` entry and `getDefaultModelForCli('antigravity')`
 * returned `undefined`: a router-off Antigravity spawn passed no `--model` and
 * agy picked its own (its flagship, not the balanced Flash model).
 *
 * The default is a rule, not a typed-in label: the newest `Gemini <version>
 * Flash (Medium)` agy currently lists. A hard-coded label went stale the day
 * agy dropped it, and agy exits 1 on a label it does not list. Falls back to
 * the provider primary if agy ever lists no Flash model.
 */
export function antigravityDefaultModel(): string | undefined {
  let best: { id: string; version: number[] } | undefined;
  for (const id of knownAntigravityModelIds()) {
    const match = ANTIGRAVITY_HOUSE_DEFAULT_PATTERN.exec(id);
    if (!match) continue;
    const version = match[1].split('.').map(Number);
    if (!best || compareVersionParts(version, best.version) > 0) {
      best = { id, version };
    }
  }
  return best?.id ?? getPrimaryModelForProvider('antigravity');
}

function compareVersionParts(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Get the default model for a CLI type.
 * Uses DEFAULT_MODELS to ensure the CLI always gets an explicit model
 * rather than falling back to its own (potentially outdated) built-in default.
 */
export function getDefaultModelForCli(cliType: string): string | undefined {
  if (cliType === 'antigravity') return antigravityDefaultModel();
  const providerType = CLI_TO_PROVIDER_TYPE[cliType];
  return providerType ? DEFAULT_MODELS[providerType] : undefined;
}
