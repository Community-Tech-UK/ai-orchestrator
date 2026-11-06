/**
 * Offline context-window fallback for the model picker (plan Step 12a).
 *
 * The unified catalogue only learns a window from models.dev, so before that
 * data arrives (and for bare aliases such as `opus` or `sonnet[1m]`, which
 * models.dev never lists) the picker would show no size. This module answers
 * from the tables Harness already uses elsewhere, and returns `undefined`
 * where none of them has a value. For claude, codex and grok it returns the
 * context bar's own figure, which falls back to that provider's default
 * window for an id the table does not list, so the picker shows the same size
 * the context bar would use.
 *
 * - claude / codex / grok: `getProviderModelContextWindow`, the table behind
 *   the context bar (`[1m]` and Opus/Sonnet 4.6+ are 1M, Haiku and older
 *   pinned ids are 200K, Codex is 200K, Grok is 500K).
 * - gemini: the generated static catalogue (`MODEL_CATALOG`, 1M). The shared
 *   table above has no Gemini branch and would answer a blanket 200K, which
 *   disagrees with the Gemini adapter's own 1M context bar.
 * - every other provider: no value.
 *
 * A live window (models.dev, a CLI report, an override) always outranks this;
 * callers use it only where they have none.
 */

import { getProviderModelContextWindow } from '../types/provider-context-window';
import { getModelCatalogEntry } from './models-catalog';

const TABLE_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'grok']);

export function getStaticContextWindow(provider: string, modelId: string): number | undefined {
  const normalized = provider.trim().toLowerCase();
  if (TABLE_PROVIDERS.has(normalized)) {
    return getProviderModelContextWindow(normalized, modelId);
  }
  if (normalized === 'gemini') {
    const entry = getModelCatalogEntry(modelId);
    return entry?.provider === 'google' ? entry.contextWindow : undefined;
  }
  return undefined;
}
