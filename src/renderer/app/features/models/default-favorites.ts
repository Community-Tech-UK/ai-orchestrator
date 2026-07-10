import {
  CLAUDE_MODELS,
  CLAUDE_PINNED_MODELS,
  OPENAI_MODELS,
} from '../../../../shared/types/provider.types';

/**
 * Curated default favourites for the model picker's ★ tab.
 *
 * This is the source of truth for which models are favourited out of the box,
 * before the user customises the list. Customisation happens at runtime by
 * toggling the ★ on any model row (persisted to localStorage under
 * `compact-model-picker:favorites:v1`); once a user has customised, their saved
 * list wins and this default no longer applies to them.
 *
 * Each entry is a `provider:modelId` key — the same shape produced by
 * `modelKey(provider, model.id)` in `model-selection-panel.component.ts`. Keys
 * are built from the typed model constants so they stay in sync with the
 * catalog in `provider.types.ts`.
 *
 * To change the out-of-the-box favourites, edit THIS list. Keys that don't
 * match a currently-available model are ignored; if none match, the picker
 * falls back to one primary model per available provider so the tab is never
 * empty.
 */
export const DEFAULT_FAVORITE_MODEL_KEYS: readonly string[] = [
  `claude:${CLAUDE_PINNED_MODELS.FABLE_5}`, // Fable 5
  `claude:${CLAUDE_MODELS.OPUS_1M}`, // Opus latest, 1M
  `codex:${OPENAI_MODELS.GPT56_SOL}`, // GPT-5.6 Sol
];
