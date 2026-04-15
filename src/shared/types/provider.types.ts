/**
 * Provider Types - Abstractions for AI providers
 */

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
  | 'amazon-bedrock'  // AWS Bedrock
  | 'azure';          // Azure OpenAI

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
  provider: ProviderType;
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
  type: ProviderType;
  name: string;
  enabled: boolean;
  apiKey?: string;
  apiEndpoint?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  options?: Record<string, unknown>;
}

/**
 * Provider status
 */
export interface ProviderStatus {
  type: ProviderType;
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
 * Legacy provider response events (for streaming).
 *
 * @deprecated Use {@link ProviderRuntimeEvent} from `@contracts/types` instead.
 * This type uses a `type` discriminant with a limited set of event kinds.
 * The contracts-based `ProviderRuntimeEvent` uses a `kind` discriminant with
 * richer, provider-agnostic event coverage (status, context, exit, spawned, etc.).
 *
 * This type is retained for backward compatibility and will be removed in a
 * future version.
 */
export type ProviderEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; result: string; isError?: boolean }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done'; usage?: ProviderUsage };

/**
 * Usage statistics from provider
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
  resume?: boolean;
  toolsEnabled?: boolean;
  yoloMode?: boolean;
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
 * OpenAI model identifiers
 */
export const OPENAI_MODELS = {
  GPT54: 'gpt-5.4',
  GPT54_MINI: 'gpt-5.4-mini',
  GPT53_CODEX: 'gpt-5.3-codex',
  GPT53_CODEX_SPARK: 'gpt-5.3-codex-spark',
  GPT52: 'gpt-5.2',
} as const;

/**
 * Google model identifiers
 */
export const GOOGLE_MODELS = {
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
  // Flagship tier - latest and best
  CLAUDE_OPUS_46: 'claude-opus-4-6',
  O3: 'o3',
  GEMINI_3_1_PRO: 'gemini-3.1-pro-preview',
  GEMINI_3_PRO: 'gemini-3-pro-preview',
  GEMINI_25_PRO: 'gemini-2.5-pro',
  // High performance tier
  CLAUDE_SONNET_46: 'claude-sonnet-4-6',
  GPT54: 'gpt-5.4',
  GEMINI_3_FLASH: 'gemini-3-flash-preview',
  GEMINI_20_FLASH: 'gemini-2.0-flash',
  // Fast tier
  CLAUDE_HAIKU_46: 'claude-haiku-4-6',
  GPT54_MINI: 'gpt-5.4-mini',
  GEMINI_20_FLASH_LITE: 'gemini-2.0-flash-lite',
} as const;

/**
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  'claude-cli': CLAUDE_MODELS.SONNET,
  'anthropic-api': CLAUDE_MODELS.SONNET,
  'openai': OPENAI_MODELS.GPT54,
  'openai-compatible': OPENAI_MODELS.GPT54,
  'ollama': 'llama3',
  'google': GOOGLE_MODELS.GEMINI_3_1_PRO,
  'amazon-bedrock': 'anthropic.claude-sonnet-4-6-20260401-v1:0',
  'azure': OPENAI_MODELS.GPT54,
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
  'claude-sonnet-4-6-20260401': { input: 3.0, output: 15.0 },
  'claude-opus-4-6-20260401': { input: 5.0, output: 25.0 },
  'claude-haiku-4-6-20260401': { input: 1.0, output: 5.0 },
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
  [OPENAI_MODELS.GPT54]: { input: 5.0, output: 20.0 },
  [OPENAI_MODELS.GPT54_MINI]: { input: 1.5, output: 6.0 },
  [OPENAI_MODELS.GPT53_CODEX]: { input: 2.5, output: 10.0 },
  [OPENAI_MODELS.GPT53_CODEX_SPARK]: { input: 0.5, output: 2.0 },
  [OPENAI_MODELS.GPT52]: { input: 2.0, output: 8.0 },
  // Google models
  [GOOGLE_MODELS.GEMINI_3_1_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_3_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_3_FLASH]: { input: 0.15, output: 0.60 },
  [GOOGLE_MODELS.GEMINI_25_PRO]: { input: 1.25, output: 10.0 },
  [GOOGLE_MODELS.GEMINI_25_FLASH]: { input: 0.15, output: 0.60 },
};

/**
 * Display info for model dropdown menus
 */
export interface ModelDisplayInfo {
  id: string;
  name: string;
  tier: 'fast' | 'balanced' | 'powerful';
}

/**
 * Default/fallback models per CLI provider (for dropdown display).
 * Used when the provider does not support dynamic model listing.
 * Copilot dynamically fetches models via SDK; others use these static lists.
 * Keys match InstanceProvider from instance.types.ts.
 */
export const PROVIDER_MODEL_LIST: Record<string, ModelDisplayInfo[]> = {
  claude: [
    { id: CLAUDE_MODELS.OPUS, name: 'Opus (latest)', tier: 'powerful' },
    { id: CLAUDE_MODELS.OPUS_1M, name: 'Opus (latest, 1M)', tier: 'powerful' },
    { id: CLAUDE_MODELS.SONNET, name: 'Sonnet (latest)', tier: 'balanced' },
    { id: CLAUDE_MODELS.SONNET_1M, name: 'Sonnet (latest, 1M)', tier: 'balanced' },
    { id: CLAUDE_MODELS.HAIKU, name: 'Haiku (latest)', tier: 'fast' },
  ],
  codex: [
    { id: OPENAI_MODELS.GPT54, name: 'GPT-5.4', tier: 'powerful' },
    { id: OPENAI_MODELS.GPT54, name: 'GPT-5.4', tier: 'balanced' },
    { id: OPENAI_MODELS.GPT54_MINI, name: 'GPT-5.4 Mini', tier: 'fast' },
  ],
  gemini: [
    { id: GOOGLE_MODELS.GEMINI_3_1_PRO, name: 'Gemini 3.1 Pro (Preview)', tier: 'powerful' },
    { id: GOOGLE_MODELS.GEMINI_3_PRO, name: 'Gemini 3 Pro (Preview)', tier: 'powerful' },
    { id: GOOGLE_MODELS.GEMINI_3_FLASH, name: 'Gemini 3 Flash (Preview)', tier: 'balanced' },
    { id: GOOGLE_MODELS.GEMINI_25_PRO, name: 'Gemini 2.5 Pro', tier: 'powerful' },
    { id: GOOGLE_MODELS.GEMINI_25_FLASH, name: 'Gemini 2.5 Flash', tier: 'fast' },
  ],
  copilot: [
    { id: COPILOT_MODELS.CLAUDE_OPUS_46, name: 'Claude Opus 4.6', tier: 'powerful' },
    { id: COPILOT_MODELS.O3, name: 'OpenAI o3', tier: 'powerful' },
    { id: COPILOT_MODELS.GEMINI_3_1_PRO, name: 'Gemini 3.1 Pro (Preview)', tier: 'powerful' },
    { id: COPILOT_MODELS.GEMINI_3_PRO, name: 'Gemini 3 Pro (Preview)', tier: 'powerful' },
    { id: COPILOT_MODELS.GEMINI_25_PRO, name: 'Gemini 2.5 Pro', tier: 'powerful' },
    { id: COPILOT_MODELS.CLAUDE_SONNET_46, name: 'Claude Sonnet 4.6', tier: 'balanced' },
    { id: COPILOT_MODELS.GPT54, name: 'GPT-5.4', tier: 'balanced' },
    { id: COPILOT_MODELS.GEMINI_3_FLASH, name: 'Gemini 3 Flash', tier: 'fast' },
    { id: COPILOT_MODELS.GEMINI_20_FLASH, name: 'Gemini 2.0 Flash', tier: 'fast' },
    { id: COPILOT_MODELS.CLAUDE_HAIKU_46, name: 'Claude Haiku 4.6', tier: 'fast' },
    { id: COPILOT_MODELS.GPT54_MINI, name: 'GPT-5.4 Mini', tier: 'fast' },
    { id: COPILOT_MODELS.GEMINI_20_FLASH_LITE, name: 'Gemini 2.0 Flash Lite', tier: 'fast' },
  ],
  ollama: [],
};

/**
 * Get available models for a given CLI provider.
 */
export function getModelsForProvider(provider: string): ModelDisplayInfo[] {
  return PROVIDER_MODEL_LIST[provider] ?? [];
}

/**
 * Return the expected context window for a provider + model combination.
 *
 * Claude Code CLI defaults to 200k for most models.  Only Opus 4.6+ and
 * Sonnet 4.6+ natively expose 1M.  For older models the `[1m]` suffix
 * requests the `context-1m-2025-08-07` beta header, which also yields 1M.
 *
 * NOTE: Claude Code CLI has known bugs where it reports 200k even for
 * 1M-capable models (see GitHub issues #23432, #34083, #36649).  The
 * adapter should use `Math.max(cliReported, thisValue)` to avoid being
 * downgraded by a buggy CLI report.
 */
export function getProviderModelContextWindow(
  provider: string,
  modelId?: string
): number {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = modelId?.trim().toLowerCase() ?? '';
  const isClaudeProvider =
    normalizedProvider === 'claude' ||
    normalizedProvider === 'claude-cli' ||
    normalizedProvider === 'anthropic' ||
    normalizedProvider === 'anthropic-api';

  // Codex / OpenAI providers — model-specific windows.
  const isCodexProvider =
    normalizedProvider === 'codex' ||
    normalizedProvider === 'codex-cli' ||
    normalizedProvider === 'openai';
  if (isCodexProvider) {
    // GPT-5 family and unspecified models default to 200k.
    return 200000;
  }

  if (!isClaudeProvider) {
    return 200000;
  }

  // Explicit 1M request via [1m] suffix (e.g. "opus[1m]", "sonnet[1m]")
  if (normalizedModel.includes('[1m]')) {
    return 1000000;
  }

  // Models that natively support 1M context (no beta header needed).
  // Bare "opus" / "sonnet" resolve server-side to the latest (4.6+),
  // which has native 1M support.
  if (
    normalizedModel === 'opus' ||
    normalizedModel === 'sonnet' ||
    normalizedModel.includes('opus-4-6') ||
    normalizedModel.includes('opus-4.6') ||
    normalizedModel.includes('sonnet-4-6') ||
    normalizedModel.includes('sonnet-4.6')
  ) {
    return 1000000;
  }

  // When model is unspecified (empty string), bare "opus"/"sonnet" is the
  // server-side default and resolves to 4.6+ which natively supports 1M.
  // Only fall back to 200k for explicitly pinned older models or haiku.
  if (normalizedModel === '' || normalizedModel === 'default') {
    return 1000000;
  }

  // All other Claude models (haiku, pinned older versions) default to 200k
  return 200000;
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
  copilot: 'claude-cli',
  ollama: 'ollama',
};

/**
 * Get the default model for a CLI type.
 * Uses DEFAULT_MODELS to ensure the CLI always gets an explicit model
 * rather than falling back to its own (potentially outdated) built-in default.
 */
export function getDefaultModelForCli(cliType: string): string | undefined {
  const providerType = CLI_TO_PROVIDER_TYPE[cliType];
  return providerType ? DEFAULT_MODELS[providerType] : undefined;
}
