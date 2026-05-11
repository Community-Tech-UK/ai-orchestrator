// Re-export the normalized runtime event contract from @contracts.
// SDK consumers should prefer these types for new integrations.
import type { ProviderPromptWeightBreakdown } from '@contracts/types/provider-runtime-events';

export type {
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
  ProviderEventKind,
  ProviderOutputEvent,
  ProviderToolUseEvent,
  ProviderToolResultEvent,
  ProviderStatusEvent,
  ProviderContextEvent,
  ProviderErrorEvent,
  ProviderExitEvent,
  ProviderSpawnedEvent,
  ProviderCompleteEvent,
  ProviderRateLimitDiagnostics,
  ProviderQuotaDiagnostics,
  ProviderPromptWeightBreakdown,
} from '@contracts/types/provider-runtime-events';

export type ProviderType =
  | 'claude-cli'
  | 'anthropic-api'
  | 'openai'
  | 'openai-compatible'
  | 'ollama'
  | 'google'
  | 'amazon-bedrock'
  | 'azure';

export interface ProviderCapabilities {
  toolExecution: boolean;
  streaming: boolean;
  multiTurn: boolean;
  vision: boolean;
  fileAttachments: boolean;
  functionCalling: boolean;
  builtInCodeTools: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  capabilities: Partial<ProviderCapabilities>;
}

/**
 * Static metadata about a provider that is known at registration time,
 * independent of any running instance.
 *
 * Inspired by t3code ProviderDriver.ts (cursor.md §5, copilot.md §6):
 * reject invalid duplicate-instance startup early at the registry boundary
 * instead of failing later inside providers.
 */
export interface ProviderDescriptor {
  type: ProviderType;
  /** Human-readable display name shown in the UI. */
  displayName: string;
  /** When false, only one instance of this provider may be live at a time.
   *  The registry will reject a second instance with an actionable error. */
  supportsMultipleInstances: boolean;
  /** Provider-specific config schema decoded at registration time.
   *  Use `z.object({...}).parse(rawConfig)` in the provider's
   *  `register()` method and store the typed result here. */
  configSchema?: Record<string, unknown>;
}

export interface ProviderConfig {
  type: ProviderType;
  name: string;
  enabled: boolean;
  apiKey?: string;
  apiEndpoint?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  options?: Record<string, unknown>;
  /** Static descriptor. When present, the registry validates instance
   *  multiplicity before spawning. */
  descriptor?: ProviderDescriptor;
}

export interface ProviderStatus {
  type: ProviderType;
  available: boolean;
  authenticated: boolean;
  error?: string;
  models?: ModelInfo[];
}

export interface ProviderAttachment {
  type: 'image' | 'file' | 'code';
  name: string;
  mimeType: string;
  data: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  estimatedCost?: number;
}

// ── System message customisation ─────────────────────────────────────────────
// Inspired by copilot-sdk systemMessage.customize pattern. Allows debate /
// subagent roles to override specific named sections of a system prompt without
// replacing the safety guardrails.

/** Named sections of a structured system prompt. */
export type SystemMessageSection =
  | 'identity'
  | 'tone'
  | 'safety'
  | 'code_change_rules'
  | 'task_instructions';

export interface SystemMessageSectionOverride {
  action: 'replace' | 'append' | 'prepend' | 'remove';
  content?: string;
}

/**
 * Controls how a provider or orchestration role modifies the system prompt.
 *
 * - `'append'`    — add content after the base system prompt (default, safe)
 * - `'replace'`   — replace the entire system prompt (loses safety section)
 * - `'customize'` — override named sections while preserving the rest
 *
 * Debate/subagent roles should use `'customize'` and override only `tone` or
 * `task_instructions`; the `safety` section should never be overridden by
 * machine-controlled roles.
 */
export interface SystemMessageConfig {
  mode: 'append' | 'replace' | 'customize';
  /** Additional content appended/replaced depending on `mode`. */
  content?: string;
  /** Section-level overrides. Only honoured when `mode === 'customize'`. */
  sections?: Partial<Record<SystemMessageSection, SystemMessageSectionOverride>>;
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy provider event type.
 *
 * @deprecated Use {@link ProviderRuntimeEvent} from `@contracts/types` instead.
 * The contracts-based type provides richer, provider-agnostic event coverage.
 * This type is retained for backward compatibility and will be removed in a
 * future version.
 */
export interface ProviderSessionOptions {
  model?: string;
  /** Simple string system prompt. Prefer `systemMessageConfig` for
   *  orchestration roles that need section-level overrides. */
  systemPrompt?: string;
  /** Structured system message config. When set, takes precedence over
   *  `systemPrompt` and enables section-level customisation. */
  systemMessageConfig?: SystemMessageConfig;
  maxTokens?: number;
  temperature?: number;
  workingDirectory: string;
  sessionId?: string;
  resume?: boolean;
  toolsEnabled?: boolean;
  yoloMode?: boolean;
}

export interface ProviderOutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
}

export type ProviderInstanceStatus =
  | 'initializing'
  | 'ready'
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'respawning'
  | 'hibernating'
  | 'hibernated'
  | 'waking'
  | 'degraded'
  | 'error'
  | 'failed'
  | 'terminated';

export interface ProviderContextUsage {
  used: number;
  total: number;
  percentage: number;
  cumulativeTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  source?: string;
  promptWeight?: number;
  promptWeightBreakdown?: ProviderPromptWeightBreakdown;
  costEstimate?: number;
}

export interface ProviderEvents {
  output: (message: ProviderOutputMessage) => void;
  status: (status: ProviderInstanceStatus) => void;
  context: (usage: ProviderContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number | null) => void;
}

// BaseProvider and ProviderFactory have been removed.
// Build new providers against @sdk/provider-adapter (ProviderAdapter interface)
// instead of the old BaseProvider class.
//
// Migration: extend the runtime BaseProvider from src/main/providers/provider-interface.ts
// and register via provider-adapter-registry.  The SDK type surface (ProviderConfig,
// ProviderStatus, ModelInfo, etc.) remains stable for configuration and status types.
