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
 * Provider response events (for streaming)
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
 * Claude model identifiers - UPDATE THESE WHEN NEW MODELS RELEASE
 * All other files should import and reference these constants.
 */
export const CLAUDE_MODELS = {
  // Current models (4.5 generation)
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-5-20250929',
  OPUS: 'claude-opus-4-5-20250918',
  // Aliases for routing tiers
  FAST: 'claude-haiku-4-5-20251001',
  BALANCED: 'claude-sonnet-4-5-20250929',
  POWERFUL: 'claude-opus-4-5-20250918',
} as const;

/**
 * OpenAI model identifiers
 */
export const OPENAI_MODELS = {
  GPT4O: 'gpt-4o',
  GPT4O_MINI: 'gpt-4o-mini',
  GPT4_TURBO: 'gpt-4-turbo',
} as const;

/**
 * Google model identifiers
 */
export const GOOGLE_MODELS = {
  GEMINI_PRO: 'gemini-1.5-pro',
  GEMINI_FLASH: 'gemini-1.5-flash',
} as const;

/**
 * GitHub Copilot model identifiers
 * Note: Copilot provides access to multiple model families
 * These are the latest models - will be dynamically fetched from CLI at runtime
 */
export const COPILOT_MODELS = {
  // Flagship tier - latest and best
  CLAUDE_OPUS_45: 'claude-opus-4-5',
  O3: 'o3',
  GEMINI_3_PRO: 'gemini-3-pro',
  GEMINI_25_PRO: 'gemini-2.5-pro',
  // High performance tier
  CLAUDE_SONNET_45: 'claude-sonnet-4-5',
  GPT4O: 'gpt-4o',
  GEMINI_3_FLASH: 'gemini-3-flash',
  GEMINI_20_FLASH: 'gemini-2.0-flash',
  // Fast tier
  CLAUDE_HAIKU_45: 'claude-haiku-4-5',
  GPT4O_MINI: 'gpt-4o-mini',
  GEMINI_20_FLASH_LITE: 'gemini-2.0-flash-lite',
} as const;

/**
 * Default models for each provider
 */
export const DEFAULT_MODELS: Record<ProviderType, string> = {
  'claude-cli': CLAUDE_MODELS.SONNET,
  'anthropic-api': CLAUDE_MODELS.SONNET,
  'openai': OPENAI_MODELS.GPT4O,
  'openai-compatible': OPENAI_MODELS.GPT4O,
  'ollama': 'llama3',
  'google': GOOGLE_MODELS.GEMINI_PRO,
  'amazon-bedrock': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'azure': OPENAI_MODELS.GPT4O,
};

/**
 * Known model pricing (USD per million tokens)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 4.5 models (current)
  [CLAUDE_MODELS.SONNET]: { input: 3.0, output: 15.0 },
  [CLAUDE_MODELS.OPUS]: { input: 5.0, output: 25.0 },
  [CLAUDE_MODELS.HAIKU]: { input: 1.0, output: 5.0 },
  // Claude 4 models (legacy)
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  // Claude 3.5 models (legacy)
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
  // OpenAI models
  [OPENAI_MODELS.GPT4O]: { input: 2.5, output: 10.0 },
  [OPENAI_MODELS.GPT4O_MINI]: { input: 0.15, output: 0.6 },
  [OPENAI_MODELS.GPT4_TURBO]: { input: 10.0, output: 30.0 },
  // Google models
  [GOOGLE_MODELS.GEMINI_PRO]: { input: 1.25, output: 5.0 },
  [GOOGLE_MODELS.GEMINI_FLASH]: { input: 0.075, output: 0.3 },
};
