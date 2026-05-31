/**
 * Classify a Copilot model ID into a tier for display.
 * Based on model naming conventions from the Copilot SDK.
 */
export function classifyCopilotModelTier(modelId: string): 'fast' | 'balanced' | 'powerful' {
  const id = modelId.toLowerCase();
  // Fast tier: mini, lite, haiku, flash variants
  if (id.includes('mini') || id.includes('lite') || id.includes('haiku') || id.includes('flash')) {
    return 'fast';
  }
  // Powerful tier: opus, o3, o1, pro variants
  if (id.includes('opus') || id === 'o3' || id === 'o1' || id.includes('-pro')) {
    return 'powerful';
  }
  // Everything else: balanced
  return 'balanced';
}
