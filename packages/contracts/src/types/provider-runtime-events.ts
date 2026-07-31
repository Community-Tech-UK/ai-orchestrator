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
// `gemini` is retained ONLY as a deprecated back-compat alias for persisted
// data and older remote nodes; `antigravity` (the `agy` CLI) is the live
// successor. New code paths should use `antigravity`.
export type BuiltInProviderName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'copilot'
  | 'anthropic-api'
  | 'cursor'
  | 'grok';

/**
 * Worker-isolated plugin providers use a reserved namespace so they cannot
 * collide with built-ins while still flowing through normalized runtime events.
 */
export type PluginProviderName = `plugin:${string}`;

export type ProviderName = BuiltInProviderName | PluginProviderName;

// ============================================
// Event Kind Discriminator
// ============================================

/**
 * All possible provider runtime event kinds.
 * Used as the discriminant in the ProviderRuntimeEvent union.
 */
export type ProviderEventKind =
  | 'output'              // Streaming text content
  | 'tool_use'            // Tool invocation started
  | 'tool_result'         // Tool invocation completed
  | 'status'              // Provider-level status transition
  | 'context'             // Context window usage update
  | 'error'               // Provider-level error
  | 'exit'                // Process/session exited
  | 'spawned'             // Process spawned
  | 'complete'            // Response turn completed
  | 'tool_use_observed'   // WS-B10: hash+summary tool-call seam for a loop guard
  | 'tool_result_observed' // WS-B10: hash+summary tool-result seam for a loop guard
  | 'unknown';            // WS-B10: fail-closed capture of an unclassifiable provider event

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
  /**
   * Process ID. `-1` is the documented sentinel for remote instances that have
   * no local pid (see RemoteCliAdapter.spawn()); local spawns report a real
   * non-negative OS pid. Consumers must not treat this as a killable OS pid
   * without checking `pid >= 0`.
   */
  pid: number;
}

/**
 * Why a completed response is considered degraded (adapter-layer detection, A3).
 *
 * - `'delayed'`         — stream stalled / took far longer than its tiny output
 *   warranted (stream-idle watchdog fired, or long elapsed time with near-zero
 *   content).
 * - `'synthetic'`       — non-cancelled near-empty output dominated by whitespace
 *   (shell hallucination / replay artefact pattern).
 * - `'cancelled'`       — the process was interrupted mid-response; the partial
 *   output is incomplete.
 * - `'duplicate-stale'` — content is byte-for-byte identical to the prior response
 *   for the same session.
 * - `'partial-replay'`  — content is highly similar (but not identical) to the
 *   prior response, indicating a replay rather than a fresh answer.
 *
 * Canonical home for the union so it survives RPC transport. The adapter-side
 * classifier (`src/main/cli/adapters/degraded-output-classifier.ts`) re-exports
 * this type rather than defining its own copy.
 */
export type DegradedReason =
  | 'delayed'
  | 'synthetic'
  | 'cancelled'
  | 'duplicate-stale'
  | 'partial-replay';

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
  /**
   * Set by the adapter-layer degraded-output classifier (A3) when the
   * `detectDegradedAdapterOutput` setting is enabled and the response looked
   * degraded. Absent on healthy turns (the default).
   */
  degradedReason?: DegradedReason;
}

/**
 * WS-B10 (2026-07-30): fail-closed capture of a provider event the current
 * normalizer could not classify into one of the other kinds — an unmapped
 * adapter event name, or a recognized event whose payload didn't have the
 * shape normalization requires (see the `[NORMALIZE_DROP]`-logged branches
 * this replaces in `adapter-runtime-event-bridge.ts`). Producers route
 * unrecognized/malformed events here instead of dropping them so nothing is
 * lost silently. This is the MANDATORY unknown-item member of the union.
 */
export interface ProviderUnknownEvent {
  kind: 'unknown';
  /**
   * Provider name embedded directly on the event for consumers that only
   * see the bare `event` value without its envelope (for example a stored
   * capture blob). Optional: the enclosing envelope's `provider` field is
   * already authoritative when the envelope is available, and pure
   * normalizers without provider context may omit it.
   */
  providerRef?: ProviderName;
  /** The adapter/provider-native event name or shape descriptor that could not be classified. */
  rawType: string;
  /**
   * JSON-safe, size-bounded snapshot of the unrecognized payload. Producers
   * MUST cap the serialized size — see `UNKNOWN_EVENT_PAYLOAD_MAX_BYTES` in
   * `adapter-runtime-event-bridge.ts`. Oversized payloads are replaced with
   * a `{ truncated: true, ... }` marker rather than sent whole.
   */
  payload: unknown;
  /** Milliseconds since epoch when the normalizer observed this event. */
  receivedAt: number;
}

/**
 * WS-B10: normalized observation of a tool invocation, purpose-built as a
 * small, hash-bearing seam for a future tool-loop guard (detecting repeated
 * identical calls without needing the full `tool_use` payload). Producers
 * may emit this alongside — not instead of — `tool_use`.
 */
export interface ProviderToolUseObservedEvent {
  kind: 'tool_use_observed';
  /** Tool name. */
  toolName: string;
  /** Correlates with the matching `tool_result_observed` event, when known. */
  callId?: string;
  /**
   * sha256 (hex, first 16 chars) of the stable-serialized tool arguments,
   * computed at normalization time. Volatile fields (timestamps, request
   * ids, etc.) are NOT stripped before hashing here — a loop detector that
   * needs volatility-insensitive comparison owns that filtering itself.
   */
  argsHash?: string;
  /** Bounded, human-readable summary of the tool arguments. */
  argsSummary: string;
}

/** WS-B10: normalized observation of a tool result, paired with `ProviderToolUseObservedEvent`. */
export interface ProviderToolResultObservedEvent {
  kind: 'tool_result_observed';
  /** Correlates with the matching `tool_use_observed` event, when known. */
  callId?: string;
  /**
   * sha256 (hex, first 16 chars) of the stable-serialized tool result,
   * computed at normalization time. See
   * `ProviderToolUseObservedEvent.argsHash` for the volatility caveat.
   */
  resultHash?: string;
  /** Bounded, human-readable summary of the tool result. */
  resultSummary: string;
  /** Whether the observed tool invocation failed, when known to the normalizer. */
  isError?: boolean;
}

// ============================================
// Discriminated Union
// ============================================

/**
 * Discriminated union of all provider runtime events.
 * Consumers can switch on `event.kind` for type-safe access to payloads.
 *
 * @frozen as of Wave 2 (2026-04-17); the original 9-kind core taxonomy
 * remains the load-bearing shape. WS-B10 (2026-07-30, event taxonomy
 * hardening — see `docs/plans/2026-07-30-sibling-audit-round2_plan.md`)
 * added three CONSERVATIVE, additive kinds under the Wave 2 design doc's
 * documented "10th kind = escalate" exception
 * (`docs/superpowers/specs/2026-04-17-wave2-provider-normalization-design.md`
 * §9): `unknown` (mandatory fail-closed capture), and
 * `tool_use_observed`/`tool_result_observed` (loop-guard seam). Do not add
 * further `kind` values without the same explicit escalation. Additive
 * optional fields on existing kinds are always permitted without escalation.
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
  | ProviderCompleteEvent
  | ProviderToolUseObservedEvent
  | ProviderToolResultObservedEvent
  | ProviderUnknownEvent;

/**
 * JSON-safe source payload retained alongside its canonical event. Runtime
 * producers normalize non-JSON values (for example Error and bigint) before
 * constructing this field, so envelopes remain safe to send through Electron
 * IPC and to persist in the local event-capture ledger.
 */
export interface ProviderRuntimeEventRaw {
  /** Stable producer seam, for example `adapter-event:output`. */
  source: string;
  /** Provider/adapter payload after JSON-safety normalization. */
  payload: unknown;
}

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
  /** Optional replay payload captured at the adapter event boundary. */
  readonly raw?: ProviderRuntimeEventRaw;
  /**
   * WS-B10: marks this occurrence as must-not-persist. Durable forensic
   * capture (`ProviderEventCaptureService`, gated in
   * `ProviderRuntimeEventBus.captureRawBackedEvent`) skips ephemeral
   * envelopes even when `raw` is attached. Renderer-facing emission
   * (`provider:normalized-event`) is unaffected — `ephemeral` only gates
   * durable persistence. Absent/false means "persist as before."
   */
  readonly ephemeral?: boolean;
  readonly event: ProviderRuntimeEvent;
}
