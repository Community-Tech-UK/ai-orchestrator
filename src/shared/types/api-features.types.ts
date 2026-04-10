/**
 * API Features Types
 * Type definitions for Anthropic API features: prompt caching and context editing
 * Verified against official docs on 2026-01-28
 */

// ============================================
// Prompt Caching Types
// ============================================

/**
 * Cache control configuration for prompt caching
 */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

/**
 * Text block with optional cache control
 */
export interface CacheableTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

/**
 * System prompt that can contain cacheable blocks
 */
export type CacheableSystemPrompt = CacheableTextBlock[];

/**
 * Cache usage metrics from API response
 */
export interface CacheUsageMetrics {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
}

/**
 * Calculated cache performance metrics
 */
export interface CachePerformanceMetrics {
  hitRate: number;
  costSavingsPercent: number;
  tokensFromCache: number;
  tokensWrittenToCache: number;
  regularInputTokens: number;
}

// ============================================
// Context Editing Types (Beta)
// ============================================

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';

/**
 * Trigger configuration for when context editing activates
 */
export interface ContextEditTrigger {
  type: 'input_tokens' | 'tool_uses';
  value: number;
}

/**
 * Keep configuration for how much to preserve after clearing
 */
export interface ContextEditKeep {
  type: 'tool_uses' | 'thinking_turns';
  value: number;
}

/**
 * Clear at least configuration
 */
export interface ContextEditClearAtLeast {
  type: 'input_tokens';
  value: number;
}

/**
 * Tool result clearing strategy configuration
 */
export interface ClearToolUsesStrategy {
  type: 'clear_tool_uses_20250919';
  trigger?: ContextEditTrigger;
  keep?: ContextEditKeep;
  clear_at_least?: ContextEditClearAtLeast;
  exclude_tools?: string[];
  clear_tool_inputs?: boolean;
}

/**
 * Thinking block clearing strategy configuration
 */
export interface ClearThinkingStrategy {
  type: 'clear_thinking_20251015';
  keep?: ContextEditKeep | 'all';
}

/**
 * Union of all context edit strategies
 */
export type ContextEditStrategy = ClearToolUsesStrategy | ClearThinkingStrategy;

/**
 * Context management configuration for API request
 */
export interface ContextManagement {
  edits: ContextEditStrategy[];
}

/**
 * Applied edit result from tool clearing
 */
export interface AppliedToolClearEdit {
  type: 'clear_tool_uses_20250919';
  cleared_tool_uses: number;
  cleared_input_tokens: number;
}

/**
 * Applied edit result from thinking clearing
 */
export interface AppliedThinkingClearEdit {
  type: 'clear_thinking_20251015';
  cleared_thinking_turns: number;
  cleared_input_tokens: number;
}

/**
 * Union of applied edit results
 */
export type AppliedEdit = AppliedToolClearEdit | AppliedThinkingClearEdit;

/**
 * Context management response from API
 */
export interface ContextManagementResponse {
  applied_edits: AppliedEdit[];
}

// ============================================
// SDK Compaction Types (Client-side)
// ============================================

/**
 * Compaction control configuration for SDK tool_runner
 */
export interface CompactionControl {
  enabled: boolean;
  contextTokenThreshold?: number;
  model?: string;
  summaryPrompt?: string;
}

// ============================================
// Combined Request Types
// ============================================

/**
 * Extended message create params with prompt caching
 */
export interface CachedMessageParams {
  model: string;
  max_tokens: number;
  system?: CacheableSystemPrompt;
  messages: unknown[];
  tools?: unknown[];
}

/**
 * Extended beta message create params with context editing
 */
export interface ContextManagedMessageParams extends CachedMessageParams {
  betas: string[];
  context_management: ContextManagement;
}

// ============================================
// Feature Support
// ============================================

/**
 * Models that support prompt caching
 */
export const PROMPT_CACHING_MODELS = [
  'claude-opus-4-5-20251101',
  'claude-opus-4-1-20250805',
  'claude-opus-4-20250514',
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6-20260401',
  'claude-sonnet-4-6-20260401',
  'claude-haiku-4-6-20260401',
] as const;

/**
 * Models that support context editing
 */
export const CONTEXT_EDITING_MODELS = PROMPT_CACHING_MODELS;

/**
 * Minimum cacheable tokens by model
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  'claude-opus-4-5-20251101': 4096,
  'claude-opus-4-1-20250805': 1024,
  'claude-opus-4-20250514': 1024,
  'claude-sonnet-4-5-20250929': 1024,
  'claude-sonnet-4-20250514': 1024,
  'claude-haiku-4-5-20251001': 4096,
  'claude-opus-4-6-20260401': 4096,
  'claude-sonnet-4-6-20260401': 1024,
  'claude-haiku-4-6-20260401': 4096,
};

// ============================================
// Utility Functions
// ============================================

/**
 * Check if a model supports prompt caching.
 * Handles both full model IDs (claude-sonnet-4-5-20250929) and bare names (sonnet).
 */
export function supportsPromptCaching(model: string): boolean {
  const lower = model.toLowerCase();
  // Bare shorthand names always resolve to latest (which supports caching)
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku') return true;
  return PROMPT_CACHING_MODELS.some((m) => model.includes(m.split('-').slice(0, 3).join('-')));
}

/**
 * Check if a model supports context editing
 */
export function supportsContextEditing(model: string): boolean {
  return supportsPromptCaching(model);
}

/**
 * Get minimum cacheable tokens for a model.
 * Handles both full model IDs and bare shorthand names.
 */
export function getMinCacheableTokens(model: string): number {
  const lower = model.toLowerCase();
  // Bare shorthand names — use conservative defaults for latest models
  if (lower === 'opus' || lower === 'haiku') return 4096;
  if (lower === 'sonnet') return 1024;
  for (const [key, value] of Object.entries(MIN_CACHEABLE_TOKENS)) {
    if (model.includes(key.split('-').slice(0, 3).join('-'))) {
      return value;
    }
  }
  return 1024; // Default fallback
}

/**
 * Calculate cache performance metrics from usage
 */
export function calculateCachePerformance(usage: CacheUsageMetrics): CachePerformanceMetrics {
  const totalInputTokens =
    usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens;

  const hitRate = totalInputTokens > 0 ? usage.cache_read_input_tokens / totalInputTokens : 0;

  // Cache reads cost 10% of base, cache writes cost 125% of base
  // So savings = (cache_read * 0.9) - (cache_creation * 0.25)
  const savingsFromReads = usage.cache_read_input_tokens * 0.9;
  const costFromWrites = usage.cache_creation_input_tokens * 0.25;
  const netSavings = savingsFromReads - costFromWrites;
  const costSavingsPercent =
    totalInputTokens > 0 ? (netSavings / totalInputTokens) * 100 : 0;

  return {
    hitRate,
    costSavingsPercent: Math.max(0, costSavingsPercent),
    tokensFromCache: usage.cache_read_input_tokens,
    tokensWrittenToCache: usage.cache_creation_input_tokens,
    regularInputTokens: usage.input_tokens,
  };
}
