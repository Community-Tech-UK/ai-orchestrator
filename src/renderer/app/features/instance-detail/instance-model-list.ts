import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';

/**
 * Chooses the model list for the legacy header dropdown.
 *
 * The unified catalog is authoritative once loaded because it includes static,
 * models.dev-only, and CLI-discovered rows. Before it loads, keep the previous
 * static/dynamic fallback list so the header never renders empty.
 */
export function resolveInstanceHeaderModels(
  unifiedModels: ModelDisplayInfo[],
  fallbackModels: ModelDisplayInfo[],
): ModelDisplayInfo[] {
  return unifiedModels.length > 0 ? unifiedModels : fallbackModels;
}
