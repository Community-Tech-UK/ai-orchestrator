/**
 * Provider Types - Abstractions for AI providers
 */

import type { PluginProviderName } from '@contracts/types/provider-runtime-events';
import { getProviderModelContextWindow } from './provider-context-window';
import type { LocalModelCatalogMetadata } from './unified-model-catalog.types';

export { getProviderModelContextWindow };
export {
  clearKnownModelCatalogSnapshotForTesting,
  getKnownCatalogModelIdsForProvider,
  mergeKnownModelCatalogSnapshot,
  replaceKnownModelCatalogSnapshot,
  type KnownProviderModelId,
} from './provider-model-catalog-snapshot';

export const MAX_MODEL_ID_LENGTH = 512;

/**
 * Supported provider types
 */
export type ProviderType =
  | 'claude-cli'      // Claude Code CLI (current implementation)
  | 'anthropic-api'   // Direct Anthropic API
  | 'openai'          // OpenAI API
  | 'openai-compatible' // OpenAI-compatible APIs (local, etc.)
  | 'ollama'          // Ollama local models
  | 'google'          // Google AI (Gemini)
  | 'copilot'         // GitHub Copilot CLI (multi-LLM router via `copilot` binary)
  | 'amazon-bedrock'  // AWS Bedrock
  | 'azure'           // Azure OpenAI
  | 'cursor'          // Cursor AI editor CLI
  | 'grok';           // xAI Grok Build CLI

export type ProviderConfigType = ProviderType | PluginProviderName;

/**
 * Provider capability flags
 */
export interface ProviderCapabilities {
  /** Can execute tools (file read/write, bash, etc.) */
  toolExecution: boolean;
  /** Can stream responses */
  streaming: boolean;
  /** Supports multi-turn conversations */
  multiTurn: boolean;
  /** Can process images */
  vision: boolean;
  /** Can process files/documents */
  fileAttachments: boolean;
  /** Supports function calling */
  functionCalling: boolean;
  /** Has built-in code tools (like Claude Code) */
  builtInCodeTools: boolean;
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderConfigType;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;  // USD per million tokens
  outputPricePerMillion: number;
  capabilities: Partial<ProviderCapabilities>;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  type: ProviderConfigType;
  name: string;
  enabled: boolean;
  apiKey?: string;
  apiEndpoint?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  options?: Record<string, unknown>;
}

export interface ProviderStatus {
  type: ProviderConfigType;
  available: boolean;
  authenticated: boolean;
  error?: string;
  models?: ModelInfo[];
}

/**
 * Message for provider communication
 */
export interface ProviderMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ProviderAttachment[];
}

/**
 * Attachment for provider messages
 */
export interface ProviderAttachment {
  type: 'image' | 'file' | 'code';
  name: string;
  mimeType: string;
  data: string; // base64 for binary, raw for text
}

/**
 * Usage statistics from provider
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  estimatedCost?: number;
}

/**
 * Provider session options
 */
export interface ProviderSessionOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  workingDirectory: string;
  sessionId?: string;
  /**
   * Stable identifier for the orchestrator instance this session belongs to.
   * Populated into every `ProviderRuntimeEventEnvelope.instanceId` emitted by
   * the adapter. Added in Wave 2 (2026-04-17).
   */
  instanceId?: string;
  resume?: boolean;
  toolsEnabled?: boolean;
  yoloMode?: boolean;
}

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/**
 * The reasoning effort a provider runs at when the user hasn't picked one.
 *
 * Claude's CLI defaults to `high` (the "Default" the Claude app badges on the
 * High row), so we surface it explicitly. Codex defaults to `xhigh` so fresh
 * Codex sessions use the largest Codex thinking budget unless the user picks a
 * different level. Providers without an app-level default stay
 * provider-decided (`null` -> no `--effort` flag).
 */
export function getDefaultReasoningEffort(provider: string | null | undefined): ReasoningEffort | null {
  if (provider === 'claude') return 'high';
  if (provider === 'codex') return 'xhigh';
  if (provider === 'grok') return 'high';
  return null;
}

/**
 * Claude model identifiers - bare shorthand names so the CLI always resolves to the latest version.
 * No need to update these when new models release.
 * All other files should import and reference these constants.
 */
export const CLAUDE_MODELS = {
  // Current models (bare names → always latest)
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  SONNET_1M: 'sonnet[1m]',
  OPUS: 'opus',
  OPUS_1M: 'opus[1m]',
  // Aliases for routing tiers
  FAST: 'haiku',
  BALANCED: 'sonnet',
  POWERFUL: 'opus',
} as const;

/**
 * Claude pinned model identifiers for versioned selection.
 * Bare aliases remain the defaults; pinned IDs are available when a user wants
 * an explicit generation instead of provider-latest routing.
 */
export const CLAUDE_PINNED_MODELS = {
  FABLE_5: 'claude-fable-5',
  OPUS_48: 'claude-opus-4-8',
  OPUS_47: 'claude-opus-4-7',
  OPUS_46: 'claude-opus-4-6-20260401',
  OPUS_45: 'claude-opus-4-5-20250918',
  OPUS_4: 'claude-opus-4-20250514',
  SONNET_46: 'claude-sonnet-4-6-20260401',
  SONNET_45: 'claude-sonnet-4-5-20250929',
  SONNET_4: 'claude-sonnet-4-20250514',
  HAIKU_46: 'claude-haiku-4-6-20260401',
  HAIKU_45: 'claude-haiku-4-5-20251001',
} as const;

/**
 * Legacy Claude model aliases used only for substring pricing fallbacks.
 * App code should import these instead of hardcoding retired model IDs.
 */
export const CLAUDE_LEGACY_PRICING_ALIASES = {
  SONNET_35: 'claude-3-5-sonnet',
  HAIKU_35: 'claude-3-5-haiku',
  OPUS_3: 'claude-3-opus',
  SONNET_3: 'claude-3-sonnet',
  HAIKU_3: 'claude-3-haiku',
} as const;

/**
 * OpenAI model identifiers
 */
export const OPENAI_MODELS = {
  GPT56_SOL: 'gpt-5.6-sol',
  GPT56_TERRA: 'gpt-5.6-terra',
  GPT56_LUNA: 'gpt-5.6-luna',
  GPT55: 'gpt-5.5',
  GPT55_MINI: 'gpt-5.5-mini',
  GPT53_CODEX: 'gpt-5.3-codex',
  GPT53_CODEX_SPARK: 'gpt-5.3-codex-spark',
  GPT52: 'gpt-5.2',
} as const;

/**
 * Google model identifiers
 */
export const GOOGLE_MODELS = {
  GEMINI_35_FLASH: 'gemini-3.5-flash',
  GEMINI_3_1_PRO: 'gemini-3.1-pro-preview',
  GEMINI_3_PRO: 'gemini-3-pro-preview',
  GEMINI_3_FLASH: 'gemini-3-flash-preview',
  GEMINI_25_PRO: 'gemini-2.5-pro',
  GEMINI_25_FLASH: 'gemini-2.5-flash',
} as const;

/**
 * GitHub Copilot model identifiers
 * Note: Copilot provides access to multiple model families
 * These are the latest models - will be dynamically fetched from CLI at runtime
 */
export const COPILOT_MODELS = {
  AUTO: 'auto',
  CLAUDE_SONNET_46: 'claude-sonnet-4.6',
  CLAUDE_SONNET_45: 'claude-sonnet-4.5',
  CLAUDE_HAIKU_45: 'claude-haiku-4.5',
  CLAUDE_OPUS_48: 'claude-opus-4.8',
  CLAUDE_OPUS_47: 'claude-opus-4.7',
  CLAUDE_OPUS_46: 'claude-opus-4.6',
  CLAUDE_OPUS_46_FAST: 'claude-opus-4.6-fast',
  CLAUDE_OPUS_45: 'claude-opus-4.5',
  CLAUDE_SONNET_4: 'claude-sonnet-4',
  GPT55: 'gpt-5.5',
  GPT54: 'gpt-5.4',
  GPT53_CODEX: 'gpt-5.3-codex',
  GPT52_CODEX: 'gpt-5.2-codex',
  GPT52: 'gpt-5.2',
  GPT51: 'gpt-5.1',
  GPT55_MINI: 'gpt-5.5-mini',
  GPT54_MINI: 'gpt-5.4-mini',
  GPT5_MINI: 'gpt-5-mini',
  GPT41: 'gpt-4.1',
  GEMINI_35_FLASH: GOOGLE_MODELS.GEMINI_35_FLASH,
  GEMINI_3_1_PRO: GOOGLE_MODELS.GEMINI_3_1_PRO,
  GEMINI_3_PRO: GOOGLE_MODELS.GEMINI_3_PRO,
  GEMINI_3_FLASH: GOOGLE_MODELS.GEMINI_3_FLASH,
  GEMINI_25_PRO: GOOGLE_MODELS.GEMINI_25_PRO,
  GEMINI_25_FLASH: GOOGLE_MODELS.GEMINI_25_FLASH,
  // GitHub's own fine-tuned model, surfaced only through the Copilot gateway.
  RAPTOR_MINI: 'raptor-mini',
} as const;

/**
 * Cursor model identifiers.
 *
 * Cursor rotates its first-class model list frequently. The adapter treats
 * `cliConfig.model` as opaque — this constant is only a minimal set of
 * well-known aliases for UI tiering and pricing fallback. The real list is
 * fetched dynamically at runtime (follow-up).
 */
export const CURSOR_MODELS = {
  /** Sentinel: omit --model flag entirely so the CLI picks from subscription. */
  AUTO: 'auto',
} as const;

export const GROK_MODELS = {
  GROK_45: 'grok-4.5',
} as const;

/**
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  // Plain Opus, NOT the [1m] variant: this default feeds one-shot orchestration
  // invocations (verify/review/debate/workflow) via getDefaultModelForCli, where
  // prompts sit far below 200k — the 1M window buys nothing there while exposing
  // runs to long-context premium billing. Interactive new sessions still default
  // to Opus-1M via PROVIDER_MODEL_LIST[0] / getPrimaryModelForProvider.
  'claude-cli': CLAUDE_MODELS.OPUS,
  'anthropic-api': CLAUDE_MODELS.OPUS,
  'openai': OPENAI_MODELS.GPT56_SOL,
  'openai-compatible': OPENAI_MODELS.GPT55,
  'ollama': 'llama3',
  // NOTE: We default to GEMINI_3_PRO ('gemini-3-pro-preview') instead of
  // GEMINI_3_1_PRO ('gemini-3.1-pro-preview') because Google's Code Assist
  // backend (cloudcode-pa.googleapis.com — what `gemini-cli` uses on free /
  // OAuth login auth) returns persistent 429 RESOURCE_EXHAUSTED /
  // MODEL_CAPACITY_EXHAUSTED for the canonical `gemini-3.1-pro-preview` ID
  // for many users. Sending `gemini-3-pro-preview` instead is server-side
  // routed to the same Gemini 3.1 Pro infrastructure (visible in the
  // response `stats.models` block) but through a non-saturated capacity
  // bucket. Revert when Google fixes capacity for the canonical ID.
  // See `gemini-cli` issue google-gemini/gemini-cli#24159.
  'google': GOOGLE_MODELS.GEMINI_3_PRO,
  // Copilot proxies Gemini through GitHub's gateway, not Code Assist, so it
  // does not hit the same capacity bucket — leave it on the canonical ID.
  'copilot': COPILOT_MODELS.GEMINI_3_1_PRO,
  'amazon-bedrock': 'anthropic.claude-sonnet-4-6-20260401-v1:0',
  'azure': OPENAI_MODELS.GPT55,
  cursor: CURSOR_MODELS.AUTO,
  grok: GROK_MODELS.GROK_45,
};

/**
 * Known model pricing (USD per million tokens)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude current models (bare shorthand keys)
  [CLAUDE_MODELS.SONNET]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.SONNET_1M]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.OPUS]: { input: 5.0, output: 25.0 },
  [CLAUDE_MODELS.OPUS_1M]: { input: 5.0, output: 25.0 },
  [CLAUDE_MODELS.HAIKU]: { input: 1.0, output: 5.0 },
  // Claude models (full IDs for API-level pricing lookups)
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'claude-sonnet-4-6-20260401': { input: 3.0, output: 15.0 },
  'claude-opus-4-6-20260401': { input: 5.0, output: 25.0 },
  'claude-haiku-4-6-20260401': { input: 1.0, output: 5.0 },
  // Claude Opus 4.7 (released 2026-04-16, bare-alias form — Anthropic
  // dropped date suffixes from canonical IDs starting with 4.6).
  // Pricing identical to Opus 4.6. Note: new tokenizer uses up to ~35%
  // more tokens per char than 4.6, so effective cost may rise.
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-opus-4-7': { input: 5.0, output: 25.0 },
  // Claude 4.5 models (previous generation)
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-5-20250918': { input: 5.0, output: 25.0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  // Claude 4 models (legacy — removed from first-party API, auto-migrated to 4.6)
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  // Claude 3.5 models (legacy)
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
  // OpenAI / Codex models (GPT-5 family)
  [OPENAI_MODELS.GPT56_SOL]: { input: 5.0, output: 30.0 },
  [OPENAI_MODELS.GPT56_TERRA]: { input: 2.5, output: 15.0 },
  [OPENAI_MODELS.GPT56_LUNA]: { input: 1.0, output: 6.0 },
  [OPENAI_MODELS.GPT55]: { input: 5.0, output: 20.0 },
  [OPENAI_MODELS.GPT55_MINI]: { input: 1.5, output: 6.0 },
  // GPT-5.4 family (added via Copilot CLI / GitHub Copilot, May 2026).
  // Priced between 5.5 and 5.3-codex pending published per-token rates.
  'gpt-5.4': { input: 4.0, output: 16.0 },
  'gpt-5.4-mini': { input: 1.0, output: 4.0 },
  [OPENAI_MODELS.GPT53_CODEX]: { input: 2.5, output: 10.0 },
  [OPENAI_MODELS.GPT53_CODEX_SPARK]: { input: 0.5, output: 2.0 },
  [OPENAI_MODELS.GPT52]: { input: 2.0, output: 8.0 },
  // Google models
  [GOOGLE_MODELS.GEMINI_35_FLASH]: { input: 0.15, output: 0.60 },
  [GOOGLE_MODELS.GEMINI_3_1_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_3_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_3_FLASH]: { input: 0.15, output: 0.60 },
  [GOOGLE_MODELS.GEMINI_25_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_25_FLASH]: { input: 0.15, output: 0.60 },
  // Grok Build / xAI (subscription-backed CLI; rates are approximate API list prices)
  [GROK_MODELS.GROK_45]: { input: 2.0, output: 10.0 },
};

/**
 * Display info for model dropdown menus.
 *
 * `pinned` and `family` are consumed by the compact model picker:
 *   - `pinned: true` surfaces the entry in the top "Latest" section without
 *     a section header. The provider's primary default model (per
 *     `getPrimaryModelForProvider`) must always be pinned — enforced by a
 *     unit invariant in `provider.types.spec.ts`.
 *   - `family` groups non-pinned entries inside the "Other versions"
 *     submenu (e.g. 'Opus' / 'Sonnet' / 'Haiku' for Claude). Untagged
 *     dynamically-discovered entries fall through to a default group.
 */
export interface ModelDisplayInfo {
  id: string;
  name: string;
  tier: 'fast' | 'balanced' | 'powerful';
  pinned?: boolean;
  family?: string;
  localModel?: LocalModelCatalogMetadata;
}

/**
 * Default/fallback models per CLI provider (for dropdown display).
 * Used when the provider does not support dynamic model listing.
 * Copilot dynamically fetches models from the installed CLI; this table is the
 * fallback when discovery is unavailable.
 * Keys match InstanceProvider from instance.types.ts.
 */
export const PROVIDER_MODEL_LIST: Record<string, ModelDisplayInfo[]> = {
  claude: [
    // Order matters: getPrimaryModelForProvider returns [0]; OPUS_1M is the
    // default new-session model so users get the 1M context window without
    // having to manually pick the [1m] variant every time.
    { id: CLAUDE_MODELS.OPUS_1M, name: 'Opus latest, 1M', tier: 'powerful', pinned: true, family: 'Opus' },
    { id: CLAUDE_MODELS.OPUS, name: 'Opus latest', tier: 'powerful', pinned: true, family: 'Opus' },
    { id: CLAUDE_PINNED_MODELS.FABLE_5, name: 'Fable 5', tier: 'powerful', family: 'Fable' },
    { id: CLAUDE_PINNED_MODELS.OPUS_48, name: 'Opus 4.8', tier: 'powerful', family: 'Opus' },
    { id: CLAUDE_PINNED_MODELS.OPUS_47, name: 'Opus 4.7', tier: 'powerful', family: 'Opus' },
    { id: CLAUDE_PINNED_MODELS.OPUS_46, name: 'Opus 4.6', tier: 'powerful', family: 'Opus' },
    { id: CLAUDE_PINNED_MODELS.OPUS_45, name: 'Opus 4.5', tier: 'powerful', family: 'Opus' },
    { id: CLAUDE_PINNED_MODELS.OPUS_4, name: 'Opus 4', tier: 'powerful', family: 'Opus' },
    { id: CLAUDE_MODELS.SONNET, name: 'Sonnet latest', tier: 'balanced', pinned: true, family: 'Sonnet' },
    { id: CLAUDE_MODELS.SONNET_1M, name: 'Sonnet latest, 1M', tier: 'balanced', pinned: true, family: 'Sonnet' },
    { id: CLAUDE_PINNED_MODELS.SONNET_46, name: 'Sonnet 4.6', tier: 'balanced', family: 'Sonnet' },
    { id: CLAUDE_PINNED_MODELS.SONNET_45, name: 'Sonnet 4.5', tier: 'balanced', family: 'Sonnet' },
    { id: CLAUDE_PINNED_MODELS.SONNET_4, name: 'Sonnet 4', tier: 'balanced', family: 'Sonnet' },
    { id: CLAUDE_MODELS.HAIKU, name: 'Haiku latest', tier: 'fast', pinned: true, family: 'Haiku' },
    { id: CLAUDE_PINNED_MODELS.HAIKU_46, name: 'Haiku 4.6', tier: 'fast', family: 'Haiku' },
    { id: CLAUDE_PINNED_MODELS.HAIKU_45, name: 'Haiku 4.5', tier: 'fast', family: 'Haiku' },
  ],
  codex: [
    { id: OPENAI_MODELS.GPT56_SOL, name: 'GPT-5.6 Sol', tier: 'powerful', pinned: true, family: 'GPT' },
    { id: OPENAI_MODELS.GPT56_TERRA, name: 'GPT-5.6 Terra', tier: 'balanced', family: 'GPT' },
    { id: OPENAI_MODELS.GPT56_LUNA, name: 'GPT-5.6 Luna', tier: 'fast', family: 'GPT' },
    { id: OPENAI_MODELS.GPT55, name: 'GPT-5.5', tier: 'powerful', pinned: true, family: 'GPT' },
    { id: OPENAI_MODELS.GPT53_CODEX, name: 'GPT-5.3 Codex', tier: 'balanced', family: 'GPT' },
    { id: OPENAI_MODELS.GPT53_CODEX_SPARK, name: 'GPT-5.3 Codex Spark', tier: 'fast', family: 'GPT' },
    { id: OPENAI_MODELS.GPT52, name: 'GPT-5.2', tier: 'balanced', family: 'GPT' },
    { id: OPENAI_MODELS.GPT55_MINI, name: 'GPT-5.5 Mini', tier: 'fast', pinned: true, family: 'GPT' },
  ],
  gemini: [
    // Order matters: resolveModelForTier() picks the FIRST entry matching a
    // tier. GEMINI_3_PRO ('gemini-3-pro-preview') comes before GEMINI_3_1_PRO
    // because Google's Code Assist backend currently returns 429
    // MODEL_CAPACITY_EXHAUSTED for the canonical `gemini-3.1-pro-preview`
    // ID, while the older alias is server-side routed to the same Gemini
    // 3.1 Pro infrastructure through a non-saturated bucket.
    // Labels reflect what the SERVER actually serves (per stats.models in the
    // CLI's stream-json output), not the wire string we send.
    { id: GOOGLE_MODELS.GEMINI_3_PRO, name: 'Gemini 3.1 Pro (Preview)', tier: 'powerful', pinned: true, family: 'Gemini Pro' },
    { id: GOOGLE_MODELS.GEMINI_3_1_PRO, name: 'Gemini 3.1 Pro (canonical ID — currently capacity-limited)', tier: 'powerful', family: 'Gemini Pro' },
    { id: GOOGLE_MODELS.GEMINI_3_FLASH, name: 'Gemini 3 Flash (Preview)', tier: 'balanced', pinned: true, family: 'Gemini Flash' },
    { id: GOOGLE_MODELS.GEMINI_25_PRO, name: 'Gemini 2.5 Pro', tier: 'powerful', family: 'Gemini Pro' },
    { id: GOOGLE_MODELS.GEMINI_25_FLASH, name: 'Gemini 2.5 Flash', tier: 'fast', family: 'Gemini Flash' },
  ],
  copilot: [
    // Order matters: getPrimaryModelForProvider returns [0]; the entry at index 0
    // must be pinned to satisfy the pinned-default invariant.
    { id: COPILOT_MODELS.GEMINI_3_1_PRO, name: 'Gemini 3.1 Pro (Preview)', tier: 'powerful', pinned: true, family: 'Gemini' },
    { id: COPILOT_MODELS.CLAUDE_OPUS_48, name: 'Claude Opus 4.8', tier: 'powerful', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_OPUS_47, name: 'Claude Opus 4.7', tier: 'powerful', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_OPUS_46, name: 'Claude Opus 4.6', tier: 'powerful', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_OPUS_46_FAST, name: 'Claude Opus 4.6 Fast', tier: 'powerful', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_OPUS_45, name: 'Claude Opus 4.5', tier: 'powerful', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_SONNET_46, name: 'Claude Sonnet 4.6', tier: 'balanced', pinned: true, family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_SONNET_45, name: 'Claude Sonnet 4.5', tier: 'balanced', family: 'Claude' },
    { id: COPILOT_MODELS.CLAUDE_SONNET_4, name: 'Claude Sonnet 4', tier: 'balanced', family: 'Claude' },
    { id: COPILOT_MODELS.GEMINI_35_FLASH, name: 'Gemini 3.5 Flash', tier: 'balanced', family: 'Gemini' },
    { id: COPILOT_MODELS.GEMINI_3_PRO, name: 'Gemini 3 Pro (Preview)', tier: 'powerful', family: 'Gemini' },
    { id: COPILOT_MODELS.GEMINI_3_FLASH, name: 'Gemini 3 Flash (Preview)', tier: 'balanced', family: 'Gemini' },
    { id: COPILOT_MODELS.GEMINI_25_PRO, name: 'Gemini 2.5 Pro', tier: 'powerful', family: 'Gemini' },
    { id: COPILOT_MODELS.GEMINI_25_FLASH, name: 'Gemini 2.5 Flash', tier: 'fast', family: 'Gemini' },
    { id: COPILOT_MODELS.GPT55, name: 'GPT-5.5', tier: 'balanced', pinned: true, family: 'GPT' },
    { id: COPILOT_MODELS.GPT54, name: 'GPT-5.4', tier: 'balanced', family: 'GPT' },
    { id: COPILOT_MODELS.GPT53_CODEX, name: 'GPT-5.3 Codex', tier: 'balanced', family: 'GPT' },
    { id: COPILOT_MODELS.GPT52_CODEX, name: 'GPT-5.2 Codex', tier: 'balanced', family: 'GPT' },
    { id: COPILOT_MODELS.GPT52, name: 'GPT-5.2', tier: 'balanced', family: 'GPT' },
    { id: COPILOT_MODELS.GPT51, name: 'GPT-5.1', tier: 'balanced', family: 'GPT' },
    { id: COPILOT_MODELS.CLAUDE_HAIKU_45, name: 'Claude Haiku 4.5', tier: 'fast', family: 'Claude' },
    { id: COPILOT_MODELS.GPT55_MINI, name: 'GPT-5.5 Mini', tier: 'fast', family: 'GPT' },
    { id: COPILOT_MODELS.GPT54_MINI, name: 'GPT-5.4 Mini', tier: 'fast', family: 'GPT' },
    { id: COPILOT_MODELS.GPT5_MINI, name: 'GPT-5 Mini', tier: 'fast', family: 'GPT' },
    { id: COPILOT_MODELS.GPT41, name: 'GPT-4.1', tier: 'fast', family: 'GPT' },
    { id: COPILOT_MODELS.RAPTOR_MINI, name: 'Raptor Mini (Preview)', tier: 'fast', family: 'GitHub' },
    { id: COPILOT_MODELS.AUTO, name: 'Auto', tier: 'balanced', pinned: true, family: 'Auto' },
  ],
  ollama: [],
  // Antigravity (`agy`, verified v1.0.14): `agy --model <label>` accepts the
  // EXACT display label from `agy models` (confirmed via model_config_manager
  // "Propagating selected model override" logs); an unrecognized value is
  // silently ignored and agy uses its default. So each `id` is the verbatim
  // label forwarded to `--model` and must match `agy models`. The
  // `(Low|Medium|High|Thinking)` suffix is agy's per-model reasoning tier, part
  // of the label. The adapter only forwards ids present here (isAntigravityModelId).
  antigravity: [
    { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', tier: 'powerful', pinned: true, family: 'Gemini Pro' },
    { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', tier: 'balanced', pinned: true, family: 'Gemini Flash' },
    { id: 'Claude Opus 4.6 (Thinking)', name: 'Claude Opus 4.6 (Thinking)', tier: 'powerful', pinned: true, family: 'Claude' },
    { id: 'Claude Sonnet 4.6 (Thinking)', name: 'Claude Sonnet 4.6 (Thinking)', tier: 'balanced', pinned: true, family: 'Claude' },
    { id: 'GPT-OSS 120B (Medium)', name: 'GPT-OSS 120B (Medium)', tier: 'balanced', pinned: true, family: 'GPT' },
    { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', tier: 'powerful', family: 'Gemini Pro' },
    { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', tier: 'balanced', family: 'Gemini Flash' },
    { id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', tier: 'fast', family: 'Gemini Flash' },
  ],
  cursor: [
    // The live picker (instance-detail dropdown, CLI settings) queries
    // `cursor-agent --list-models` dynamically and surfaces the full
    // (~130-model) list. This curated set is only the offline fallback plus the
    // pinned/family/tier overlay applied onto that live list — intentionally
    // just the latest useful models (latest Claude / Codex / GPT + Composer),
    // with `auto` first + pinned. Pinned set capped at 5.
    //
    // Regenerate from the installed CLI with `npm run generate:cursor-models`
    // (selection policy lives in scripts/generate-cursor-models.ts). The entries
    // between the markers below are machine-managed — edit the script, not them.
    // cursor-models:generated:start
    { id: CURSOR_MODELS.AUTO, name: 'Auto (let Cursor pick)', tier: 'balanced', pinned: true, family: 'Auto' },
    { id: 'composer-2.5', name: 'Composer 2.5', tier: 'balanced', pinned: true, family: 'Composer' },
    { id: 'claude-opus-4-8-thinking-high', name: 'Opus 4.8', tier: 'powerful', pinned: true, family: 'Claude' },
    { id: 'gpt-5.3-codex', name: 'Codex 5.3', tier: 'balanced', pinned: true, family: 'Codex' },
    { id: 'gpt-5.5-high', name: 'GPT 5.5 High', tier: 'balanced', pinned: true, family: 'GPT' },
    // cursor-models:generated:end
  ],
  grok: [
    { id: GROK_MODELS.GROK_45, name: 'Grok 4.5', tier: 'powerful', pinned: true, family: 'Grok' },
  ],
};

/**
 * Derived model-resolution helpers live in provider-model-utils.ts to keep this
 * module focused on type definitions and the static catalog. Re-exported here so
 * existing import sites (`@shared/types/provider.types`) keep working. The cycle
 * is safe: provider-model-utils reads the catalog constants above only inside
 * function bodies, never at module-evaluation time.
 */
export {
  getModelsForProvider,
  isAntigravityModelId,
  normalizeModelAliasForProvider,
  getPrimaryModelForProvider,
  normalizeModelForProvider,
  looksLikeCodexModelId,
  isModelTier,
  resolveModelForTier,
  getModelShortName,
  getDefaultModelForCli,
} from './provider-model-utils';
