import type { AutomationAction } from '../types/automation.types';
import type { InstanceProvider } from '../types/instance.types';
import type { CliType } from '../types/settings.types';
import {
  CLAUDE_MODELS,
  CLAUDE_PINNED_MODELS,
  OPENAI_MODELS,
  resolveModelReplacementForProvider,
} from '../types/provider.types';

/**
 * Pure, renderer-safe fire-time model resolution for automations.
 *
 * This module imports only shared types — no `getSettingsManager`, no Electron
 * — so the automations edit dialog can compute its "what will actually run"
 * preview with the SAME function the main-process runner uses. Display and
 * runtime therefore cannot diverge.
 */

/**
 * The dedicated automation-default settings that back an automation whose Model
 * is left on **Auto**, plus the mirrored model-picker favourites.
 *
 * `automationDefaultCli`/`automationDefaultModel` are kept separate from
 * `defaultCli`/`defaultModelByProvider` because those are rewritten by
 * interactive picker usage; these are not. `modelPickerFavorites` is the
 * ordered `provider:modelId` list mirrored from the renderer picker's ★ tab.
 */
export interface AutomationModelDefaults {
  automationDefaultCli: CliType;
  automationDefaultModel: string;
  /** Ordered `provider:modelId` favourite keys; empty = "no opinion". */
  modelPickerFavorites: string[];
}

export interface AutomationSpawnTarget {
  provider: InstanceProvider | undefined;
  modelOverride: string | undefined;
}

/** Legacy persisted `'openai'` maps to the canonical `'codex'` provider. */
export function normalizeProvider(provider: CliType): InstanceProvider {
  return provider === 'openai' ? 'codex' : provider;
}

/**
 * Normalize a favourite-key provider token to the canonical provider used by
 * `InstanceProvider`, so `openai:…` favourites still match a `codex` automation.
 */
function normalizeFavoriteProvider(token: string): string {
  const trimmed = token.trim().toLowerCase();
  return trimmed === 'openai' ? 'codex' : trimmed;
}

interface ParsedFavorite {
  provider: string;
  modelId: string;
}

/**
 * Split a `provider:modelId` favourite key on the FIRST colon (model ids may
 * themselves contain colons, e.g. local-model selectors). Returns `null` for
 * malformed entries (no colon, empty provider, or empty model) so a corrupt
 * list is simply ignored rather than throwing.
 */
function parseFavoriteKey(key: unknown): ParsedFavorite | null {
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  const idx = trimmed.indexOf(':');
  if (idx <= 0) return null;
  const provider = normalizeFavoriteProvider(trimmed.slice(0, idx));
  const modelId = trimmed.slice(idx + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

/** First favourite whose (normalized) provider matches `provider`. */
function firstFavoriteForProvider(
  favorites: readonly string[],
  provider: string,
): ParsedFavorite | null {
  const target = normalizeFavoriteProvider(provider);
  for (const key of favorites) {
    const parsed = parseFavoriteKey(key);
    if (parsed && parsed.provider === target) return parsed;
  }
  return null;
}

/**
 * Which provider a model id obviously belongs to, or `undefined` when it cannot
 * be classified.
 *
 * `automationDefaultModel` is a single cross-provider setting, so without this
 * check a user who sets it to a Claude model hands that model to every codex
 * automation that has not pinned one. Deliberately conservative: only a
 * POSITIVE identification counts, so an unrecognised id (a local selector, a
 * gemini/grok model, a custom entry) still falls through exactly as before.
 */
export function modelProviderFamily(model: string): InstanceProvider | undefined {
  // Strip a context-window suffix such as "[1m]" before matching.
  const normalized = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (!normalized) return undefined;

  const claudeAliases = new Set<string>(
    Object.values(CLAUDE_MODELS).map((id) => id.replace(/\[[^\]]*\]$/, '')),
  );
  if (claudeAliases.has(normalized)) return 'claude';
  if ((Object.values(CLAUDE_PINNED_MODELS) as string[]).includes(normalized)) return 'claude';
  if (normalized.startsWith('claude-')) return 'claude';

  if ((Object.values(OPENAI_MODELS) as string[]).includes(normalized)) return 'codex';
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3')) {
    return 'codex';
  }

  return undefined;
}

/** First well-formed favourite in the list, regardless of provider. */
function firstFavorite(favorites: readonly string[]): ParsedFavorite | null {
  for (const key of favorites) {
    const parsed = parseFavoriteKey(key);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Resolve the provider + model an automation run should spawn with.
 *
 * Resolution order (a value found earlier wins):
 *   1. `action.model` pinned on the automation — always wins.
 *   2. `automationDefaultModel` setting — explicit cross-provider user opinion.
 *   3. First `modelPickerFavorites` entry whose provider prefix matches the
 *      resolved concrete provider.
 *   4. If the provider is still unresolved (`auto`/absent) and no automation
 *      default provider is set, adopt the FIRST favourite overall — taking both
 *      its provider and its model (this is the common form-created "Auto" case,
 *      where neither provider nor model is pinned).
 *   5. Otherwise the fields fall through unchanged so the normal provider/model
 *      resolution downstream takes over — i.e. an empty favourites list and no
 *      defaults is fully backwards compatible.
 *
 * A pinned provider always takes the provider-prefix path (step 3), never the
 * adopt-top path (step 4), so a codex automation with only Claude favourites
 * falls through to the codex default rather than being handed a Claude model.
 *
 * Never throws: a corrupt/empty favourites list simply falls through.
 */
export function resolveAutomationSpawnTarget(
  action: Pick<AutomationAction, 'provider' | 'model'>,
  defaults: AutomationModelDefaults,
): AutomationSpawnTarget {
  const pinnedModel = action.model?.trim() ? action.model : undefined;
  const pinnedProvider =
    action.provider && action.provider !== 'auto' ? action.provider : undefined;

  const defaultModel = defaults.automationDefaultModel?.trim()
    ? defaults.automationDefaultModel
    : undefined;
  const defaultProvider =
    defaults.automationDefaultCli && defaults.automationDefaultCli !== 'auto'
      ? normalizeProvider(defaults.automationDefaultCli)
      : undefined;

  // Provider resolves the same way it always did: pinned > automation default >
  // the automation's own (possibly 'auto') value.
  let provider = pinnedProvider ?? defaultProvider ?? action.provider;

  // The cross-provider default only applies when it could actually run on the
  // resolved provider. Handing a Claude model to the codex CLI (or the reverse)
  // is a silent misconfiguration, so a positively-identified mismatch is
  // skipped and resolution falls through to the provider-aware favourite below.
  let modelOverride = pinnedModel;
  if (modelOverride === undefined && defaultModel !== undefined) {
    const concreteProvider = provider && provider !== 'auto' ? provider : undefined;
    const family = modelProviderFamily(defaultModel);
    if (!concreteProvider || !family || family === concreteProvider) {
      modelOverride = defaultModel;
    }
  }

  const favorites = Array.isArray(defaults.modelPickerFavorites)
    ? defaults.modelPickerFavorites
    : [];

  if (modelOverride === undefined && favorites.length > 0) {
    if (provider && provider !== 'auto') {
      // Step 3: favourite for the already-resolved concrete provider.
      const match = firstFavoriteForProvider(favorites, provider);
      if (match) modelOverride = match.modelId;
    } else {
      // Step 4: provider still unresolved (auto/absent) — reachable only when
      // neither the automation nor the defaults pin a provider. Adopt the top
      // favourite overall, taking its provider and model together.
      const top = firstFavorite(favorites);
      if (top) {
        provider = top.provider as InstanceProvider;
        modelOverride = top.modelId;
      }
    }
  }

  if (modelOverride !== undefined) {
    const replacementProvider = provider && provider !== 'auto'
      ? provider
      : modelProviderFamily(modelOverride);
    if (replacementProvider) {
      modelOverride = resolveModelReplacementForProvider(replacementProvider, modelOverride);
    }
  }

  return { provider, modelOverride };
}
