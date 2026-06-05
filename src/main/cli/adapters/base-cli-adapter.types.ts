import type { DegradedReason } from './degraded-output-classifier';

/**
 * Configuration for CLI adapters
 */
export interface CliAdapterConfig {
  /** CLI executable command/path */
  command: string;
  /** Default arguments for the CLI */
  args?: string[];
  /** Working directory for the CLI process */
  cwd?: string;
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Maximum retry count on failure */
  maxRetries?: number;
  /** Support session persistence/resumption */
  sessionPersistence?: boolean;
  /**
   * When true (default), large accumulated output buffers are persisted to disk
   * and replaced with a compact preview before being processed further.
   * Disable only in contexts where full output must be retained in-process.
   */
  persistLargeOutputs?: boolean;
}

/**
 * Capabilities supported by a CLI tool
 */
export interface CliCapabilities {
  /** Real-time output streaming */
  streaming: boolean;
  /** Can execute tools/functions */
  toolUse: boolean;
  /** Can read/write files */
  fileAccess: boolean;
  /** Can run shell commands */
  shellExecution: boolean;
  /** Supports multi-turn conversations */
  multiTurn: boolean;
  /** Can process images */
  vision: boolean;
  /** Can execute code */
  codeExecution: boolean;
  /** Maximum context window (tokens) */
  contextWindow: number;
  /** Supported output formats */
  outputFormats: string[];
}

/**
 * Runtime orchestration capabilities that influence lifecycle behavior.
 */
export interface AdapterRuntimeCapabilities {
  /** Supports native session resume across adapter spawns */
  supportsResume: boolean;
  /** Supports forking a resumed session into a new session ID */
  supportsForkSession: boolean;
  /**
   * Adapter exposes a programmatic `compactContext()` hook the orchestrator
   * can call to actively trigger a real compaction (e.g. Codex app-server's
   * `thread/compact/start` JSON-RPC call). Adapters MUST implement
   * `compactContext()` when this is true; otherwise the orchestrator has no
   * way to actually compact and will fall through to restart-with-summary.
   *
   * NOTE: this flag is **only** about the existence of a callable hook. It is
   * NOT a statement about whether the adapter auto-compacts on its own — that
   * is `selfManagedAutoCompaction` below.
   */
  supportsNativeCompaction: boolean;
  /** Supports interactive permission/input-required prompts */
  supportsPermissionPrompts: boolean;
  /** Supports defer-based permission flow via PreToolUse hooks (Claude CLI 2.1.90+) */
  supportsDeferPermission: boolean;
  /**
   * Adapter manages its own context-pressure compaction internally — it will
   * compact at the model/CLI's own threshold and surface that on the output
   * stream (e.g. Claude CLI's headless `--input-format stream-json` mode
   * auto-compacts at the model's internal threshold; Codex app-server emits
   * `thread/compacted`). When true, the orchestrator's auto-trigger
   * (background/blocking thresholds in CompactionCoordinator) is suppressed
   * for this adapter — only manual user-driven compaction (Compact button,
   * IPC `instance:compact`) runs the strategy chain.
   *
   * Default: false (orchestrator drives compaction).
   */
  selfManagedAutoCompaction?: boolean;
}

/**
 * Message to send to a CLI
 */
export interface CliMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: CliAttachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Attachment for CLI messages
 */
export interface CliAttachment {
  type: 'file' | 'image' | 'code';
  path?: string;
  content?: string;
  mimeType?: string;
  name?: string;
}

/**
 * Response from a CLI
 */
export interface CliResponse {
  id: string;
  content: string;
  role: 'assistant';
  toolCalls?: CliToolCall[];
  usage?: CliUsage;
  metadata?: Record<string, unknown>;
  /** Original CLI output for debugging */
  raw?: unknown;
  /**
   * Set by the adapter-layer degraded-output classifier (A3) when
   * `detectDegradedAdapterOutput` is enabled in settings. Absent when the
   * classifier is off (default) or when no degraded signal was detected.
   * Callers (coordinators, loop supervisors) may use this tag to trigger
   * retries or emit diagnostic events — but the presence of a tag alone does
   * NOT mean the response should be discarded.
   */
  degradedReason?: DegradedReason;
}

/**
 * Tool call made by a CLI
 */
export interface CliToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

/**
 * Usage statistics from a CLI
 */
export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt tokens served from the provider's cache on this turn. Billed at a
   * reduced rate (≈10% of the input rate for Anthropic). Kept separate from
   * `inputTokens` so cost accounting can price the cached portion correctly.
   */
  cacheReadTokens?: number;
  /**
   * Prompt tokens written to the provider's cache on this turn. Billed at (or
   * above) the input rate. Kept separate from `inputTokens` for accurate cost.
   */
  cacheWriteTokens?: number;
  /**
   * Hidden reasoning/thinking tokens reported separately by providers. These
   * are generated output-side tokens and are billed at the output rate.
   */
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: number;
  duration?: number;
}

/**
 * Status of a CLI tool
 */
export interface CliStatus {
  available: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  error?: string;
  /** Adapter-specific metadata (e.g., { appServerAvailable: boolean } for Codex). */
  metadata?: Record<string, unknown>;
}

export interface TurnInterruptCompletion {
  status: 'accepted' | 'interrupted' | 'completed' | 'cancelled' | 'rejected' | 'unknown';
  turnId?: string;
  reason?: string;
}

export interface InterruptResult {
  status: 'accepted' | 'rejected' | 'already-idle' | 'no-active-turn' | 'unsupported' | 'escalated';
  turnId?: string;
  reason?: string;
  completion?: Promise<TurnInterruptCompletion>;
}

export interface ResumeAttemptResult {
  source: 'native' | 'running-adopted' | 'jsonl-scan' | 'fresh-fallback' | 'replay' | 'none';
  confirmed: boolean;
  requestedSessionId?: string;
  actualSessionId?: string;
  requestedCursor?: unknown;
  actualCursor?: unknown;
  restoredTurnCount?: number;
  restoredMessageIds?: string[];
  reason?: string;
}

/**
 * Events emitted by CLI adapters
 */
export type CliEvent =
  | 'output'      // Streaming content
  | 'tool_use'    // Tool invocation
  | 'tool_result' // Tool response
  | 'status'      // Status update
  | 'error'       // Error occurred
  | 'complete'    // Response finished
  | 'exit'        // Process exited
  | 'spawned';    // Process spawned

/**
 * Event handler types for CLI adapters
 */
export interface CliAdapterEvents {
  'output': (content: string) => void;
  'tool_use': (toolCall: CliToolCall) => void;
  'tool_result': (toolCall: CliToolCall) => void;
  'status': (status: string) => void;
  'error': (error: Error | string) => void;
  'complete': (response: CliResponse) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}
