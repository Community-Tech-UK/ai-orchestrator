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
 * CLI-level provider name used in the envelope and adapter registry.
 * Matches `InstanceProvider` in `@shared/types/instance.types`.
 */
export type ProviderName = 'claude' | 'codex' | 'gemini' | 'copilot';

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
// Event Payload Types
// ============================================

/** Streaming text output from the provider. */
export interface ProviderOutputEvent {
  kind: 'output';
  /** The text content of the output chunk. */
  content: string;
  /** Output message type (user, assistant, system, tool, etc.) */
  messageType?: string;
  /** Optional structured metadata (tool calls, citations, etc.) */
  metadata?: Record<string, unknown>;
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
  readonly event: ProviderRuntimeEvent;
}

// ============================================
// Event Mapper Interface
// ============================================

/**
 * Interface for per-provider event normalizers.
 * Each provider adapter implements this to convert raw events
 * into ProviderRuntimeEvents.
 */
export interface ProviderEventMapper {
  /** Provider identifier (e.g., 'claude', 'codex'). */
  readonly provider: string;

  /**
   * Normalize a raw provider event into a ProviderRuntimeEvent.
   * Returns null if the raw event should be filtered/ignored.
   */
  normalize(rawEventType: string, ...args: unknown[]): ProviderRuntimeEvent | null;
}
