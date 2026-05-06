/**
 * Normalized Provider Runtime Events
 *
 * A typed event envelope that all provider adapters (Claude, Codex, Gemini, Copilot)
 * normalize their raw events into. Orchestration, telemetry, and UI logic consume
 * this single provider-agnostic stream instead of handling per-provider event shapes.
 *
 * @module @contracts/types/provider-runtime-events
 */

// ============================================
// Provider Name
// ============================================

/**
 * Provider identifier used in the envelope and adapter registry.
 * Subset of `InstanceProvider` — excludes `'auto'` which is a selection-time
 * placeholder, not a concrete runtime.
 */
export type ProviderName = 'claude' | 'codex' | 'gemini' | 'copilot' | 'anthropic-api' | 'cursor';

// ============================================
// Event Kind Discriminator
// ============================================

/**
 * All possible provider runtime event kinds.
 * Used as the discriminant in the ProviderRuntimeEvent union.
 */
export type ProviderEventKind =
  | 'output'        // Streaming text content
  | 'tool_use'      // Tool invocation started
  | 'tool_result'   // Tool invocation completed
  | 'status'        // Provider-level status transition
  | 'context'       // Context window usage update
  | 'error'         // Provider-level error
  | 'exit'          // Process/session exited
  | 'spawned'       // Process spawned
  | 'complete';     // Response turn completed

// ============================================
// Shared Output Payload Shapes
// ============================================

/** File attachment metadata carried with an output event. */
export interface ProviderRuntimeAttachment {
  name: string;
  type: string;
  size: number;
  data: string;
}

/** Thinking/reasoning block carried with an output event. */
export interface ProviderRuntimeThinkingContent {
  id: string;
  content: string;
  format: 'structured' | 'xml' | 'bracket' | 'header' | 'sdk' | 'unknown';
  timestamp?: number;
  tokenCount?: number;
}

/** Normalized provider API rate-limit diagnostics. */
export interface ProviderRateLimitDiagnostics {
  limit?: number;
  remaining?: number;
  resetAt?: number;
}

/** Normalized provider quota diagnostics. */
export interface ProviderQuotaDiagnostics {
  exhausted?: boolean;
  resetAt?: number;
  message?: string;
}

/** Estimated prompt/input token attribution for diagnostics. */
export interface ProviderPromptWeightBreakdown {
  systemPrompt?: number;
  mcpToolDescriptions?: number;
  skills?: number;
  plugins?: number;
  userPrompt?: number;
  other?: number;
}

// ============================================
// Event Payload Types
// ============================================

/** Streaming text output from the provider. */
export interface ProviderOutputEvent {
  kind: 'output';
  /** The text content of the output chunk. */
  content: string;
  /** Output message type (user, assistant, system, tool, etc.) */
  messageType?: string;
  /** Stable message identifier from the originating adapter event. */
  messageId?: string;
  /** Original message timestamp (ms since epoch). */
  timestamp?: number;
  /** Optional structured metadata (tool calls, citations, etc.) */
  metadata?: Record<string, unknown>;
  /** File attachments associated with the message, if any. */
  attachments?: ProviderRuntimeAttachment[];
  /** Extracted thinking blocks associated with the message, if any. */
  thinking?: ProviderRuntimeThinkingContent[];
  /** Whether thinking content has already been extracted from the message. */
  thinkingExtracted?: boolean;
}

/** A tool use invocation started by the provider. */
export interface ProviderToolUseEvent {
  kind: 'tool_use';
  /** Tool name. */
  toolName: string;
  /** Unique ID for this tool invocation (for correlating with tool_result). */
  toolUseId?: string;
  /** Tool input arguments. */
  input?: Record<string, unknown>;
}

/** A tool invocation completed with a result. */
export interface ProviderToolResultEvent {
  kind: 'tool_result';
  /** Tool name. */
  toolName: string;
  /** Unique ID correlating with the original tool_use event. */
  toolUseId?: string;
  /** Tool output/result content. */
  output?: string;
  /** Whether the tool invocation succeeded. */
  success: boolean;
  /** Error message if the tool failed. */
  error?: string;
}

/** Provider-level status transition. */
export interface ProviderStatusEvent {
  kind: 'status';
  /** The new status string (idle, busy, etc.) */
  status: string;
}

/** Context window usage update. */
export interface ProviderContextEvent {
  kind: 'context';
  /** Tokens used so far. */
  used: number;
  /** Total context window size. */
  total: number;
  /** Usage percentage (0-100). */
  percentage?: number;
  /** Input tokens in the provider-reported API call, when known. */
  inputTokens?: number;
  /** Output tokens in the provider-reported API call, when known. */
  outputTokens?: number;
  /** Source of the context accounting, for example provider-usage or estimate. */
  source?: string;
  /** Share of the context window attributable to prompt/input tokens. */
  promptWeight?: number;
  /** Estimated token attribution for prompt/input sources. */
  promptWeightBreakdown?: ProviderPromptWeightBreakdown;
}

/** Provider-level error. */
export interface ProviderErrorEvent {
  kind: 'error';
  /** Error message. */
  message: string;
  /** Whether the error is recoverable. */
  recoverable?: boolean;
  /** Structured error details. */
  details?: Record<string, unknown>;
  /** Provider-native request identifier, redacted to the ID only. */
  requestId?: string;
  /** Provider-native stop reason when the error is tied to a turn completion. */
  stopReason?: string;
  /** Provider rate-limit summary, without raw headers. */
  rateLimit?: ProviderRateLimitDiagnostics;
  /** Provider quota summary. */
  quota?: ProviderQuotaDiagnostics;
}

/** Process/session exited. */
export interface ProviderExitEvent {
  kind: 'exit';
  /** Exit code (null if killed by signal). */
  code: number | null;
  /** Signal that killed the process (null if exited normally). */
  signal: string | null;
}

/** Process spawned. */
export interface ProviderSpawnedEvent {
  kind: 'spawned';
  /** Process ID. */
  pid: number;
}

/** Response turn completed. */
export interface ProviderCompleteEvent {
  kind: 'complete';
  /** Tokens used in this turn. */
  tokensUsed?: number;
  /** Total cost of this turn. */
  costUsd?: number;
  /** Duration of the response turn in ms. */
  durationMs?: number;
  /** Provider-native request identifier, redacted to the ID only. */
  requestId?: string;
  /** Provider-native stop reason. */
  stopReason?: string;
  /** Provider rate-limit summary, without raw headers. */
  rateLimit?: ProviderRateLimitDiagnostics;
  /** Provider quota summary. */
  quota?: ProviderQuotaDiagnostics;
}

// ============================================
// Discriminated Union
// ============================================

/**
 * Discriminated union of all provider runtime events.
 * Consumers can switch on `event.kind` for type-safe access to payloads.
 *
 * @frozen as of Wave 2 (2026-04-17). See the Wave 3 design doc for the v2
 * taxonomy (5-family hierarchical). Do not add new `kind` values to this
 * union. Additive optional fields on existing kinds are permitted.
 */
export type ProviderRuntimeEvent =
  | ProviderOutputEvent
  | ProviderToolUseEvent
  | ProviderToolResultEvent
  | ProviderStatusEvent
  | ProviderContextEvent
  | ProviderErrorEvent
  | ProviderExitEvent
  | ProviderSpawnedEvent
  | ProviderCompleteEvent;

// ============================================
// Event Envelope
// ============================================

/**
 * The top-level event envelope wrapping a provider runtime event.
 * Includes common metadata applicable to all events.
 */
export interface ProviderRuntimeEventEnvelope {
  /** UUID v4 — globally unique, stable across IPC. */
  readonly eventId: string;
  /** Monotonic per-instance counter starting at 0. Renderer gap-detection. */
  readonly seq: number;
  /** Milliseconds since epoch (Date.now()). */
  readonly timestamp: number;
  /** CLI-level provider name. */
  readonly provider: ProviderName;
  readonly instanceId: string;
  readonly sessionId?: string;
  /** Resolved model identifier used by this provider event, if known. */
  readonly model?: string;
  /** Monotonic adapter-listener generation for stale-event suppression. */
  readonly adapterGeneration?: number;
  /** Provider-native turn ID associated with this event, when known. */
  readonly turnId?: string;
  readonly event: ProviderRuntimeEvent;
}
