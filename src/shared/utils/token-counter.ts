/**
 * Estimate token count for text content.
 * Uses character-based approximation (4 chars per token).
 * For accurate counting, use LLMService.countTokens() directly.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
