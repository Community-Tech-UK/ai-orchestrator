import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';

export function resolveReviewerModels(
  unifiedModels: ModelDisplayInfo[],
  fallbackModels: ModelDisplayInfo[],
): ModelDisplayInfo[] {
  return unifiedModels.length > 0 ? unifiedModels : fallbackModels;
}
