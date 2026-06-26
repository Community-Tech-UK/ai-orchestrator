/**
 * Types for the Claude CLI Adapter.
 * Extracted from claude-cli-adapter.ts to keep that file under its line-count ceiling.
 * All symbols remain importable from `claude-cli-adapter.ts` via re-exports there.
 */

import type {
  OutputMessage,
  ContextUsage,
  InstanceStatus,
} from '../../../shared/types/instance.types';

/**
 * Shape of a content block inside raw CLI NDJSON assistant/user messages.
 * The typed CliStreamMessage union is minimal — the actual CLI emits richer payloads.
 */
export interface RawContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | RawContentBlock[];
  is_error?: boolean;
  thinking?: string;
  tool_use_id?: string;
  [key: string]: unknown;
}

/** Raw assistant/user message payload from Claude CLI NDJSON stream */
export interface RawCliPayload {
  type: string;
  subtype?: string;
  timestamp?: number;
  message?: {
    content?: RawContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    model?: string;
    role?: string;
  };
  tool?: {
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  content?: string;
  is_error?: boolean;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    contextWindow?: number;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    total_tokens?: number;
  };
  total_cost_usd?: number;
  session_id?: string;
  error?: { code: string; message: string };
  prompt?: string;
  metadata?: Record<string, unknown>;
  /** Present on result messages — indicates why the turn ended. */
  stop_reason?: string;
  /** Present when stop_reason is 'tool_deferred' — the deferred tool details. */
  deferred_tool_use?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
}

/**
 * Represents a tool use that was deferred by a PreToolUse hook.
 * The CLI paused execution and exited; the orchestrator must surface
 * an approval dialog and resume the session with the user's decision.
 */
export interface DeferredToolUse {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  deferredAt: number;
}

export type ClaudeCliReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type UnifiedReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'workflow';

/**
 * Claude CLI specific spawn options
 */
export interface ClaudeCliSpawnOptions {
  sessionId?: string;
  workingDirectory?: string;
  model?: string;
  maxTokens?: number;
  /** Agentic-turn backstop passed as `--max-turns`. When the bound is hit the
   *  CLI ends the run with a max-turns result instead of looping further;
   *  callers (e.g. Loop Mode degraded-iteration retry) handle the truncation. */
  maxTurns?: number;
  timeout?: number;
  env?: Record<string, string>;
  yoloMode?: boolean;
  resume?: boolean;
  forkSession?: boolean; // When resuming, create a new session ID instead of reusing
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPrompt?: string;
  mcpConfig?: string[];  // MCP server config file paths or inline JSON strings
  /** Enable Claude in Chrome extension integration (--chrome flag).
   *  This exposes legacy raw browser automation and must be explicitly requested. */
  chrome?: boolean;
  /** Beta headers for API requests (API key users only).
   *  e.g. ['context-1m-2025-08-07'] to enable 1M context on eligible models. */
  betas?: string[];
  /** Cross-provider reasoning effort. Claude CLI supports low, medium, high, xhigh, max, and workflow via ultracode settings. */
  reasoningEffort?: UnifiedReasoningEffort;
  /** Fast mode: emit `fastMode: true` into the --settings overlay. Opus-only;
   *  requires a paid subscription/credits. The CLI surfaces a "fast mode
   *  unavailable" notice when it can't honor it. Defaults to false. */
  fastMode?: boolean;
  /**
   * Enable the resident-session interrupt path (Phase 2c rollout gate).
   *
   * When true, the adapter sends `control_request{interrupt}` to stdin instead
   * of SIGINT, keeping the Claude CLI process alive across turns and allowing
   * mid-turn steer messages to be delivered without a respawn cycle.
   *
   * Defaults to false (opt-in). Set via AppSettings.residentClaudeSession —
   * flip that setting to true after soak validation to enable for all instances.
   * Pass `true` explicitly in tests or when calling the adapter directly.
   */
  residentClaude?: boolean;
  /** Minimal mode (--bare): skips hooks, LSP, plugins, auto-memory, CLAUDE.md
   *  auto-discovery, and keychain reads for faster startup (~14% faster).
   *  Requires explicit ANTHROPIC_API_KEY or apiKeyHelper — OAuth/keychain auth
   *  is skipped. Defaults to false to preserve existing auth flows. */
  bare?: boolean;
  /** Display name for this session (--name / -n). Shown in /resume and terminal
   *  title. If unset the CLI auto-generates a name from the first message. */
  name?: string;
  /** Move per-machine dynamic sections out of the system prompt into the first
   *  user message to improve cross-user prompt-cache hit rates.
   *  Only effective with the default system prompt (ignored with --system-prompt). */
  excludeDynamicSystemPromptSections?: boolean;
  /** Path to a PreToolUse hook script for defer-based permission approval.
   *  When set, the adapter generates a settings overlay and passes it via --settings.
   *  The hook intercepts dangerous tools (Bash, etc.) and returns `defer` to pause
   *  execution, allowing the orchestrator to surface approval UI. */
  permissionHookPath?: string;
  /** RTK rewrite integration. When `enabled` is true and `binaryPath` resolves,
   *  the spawned CLI receives ORCHESTRATOR_RTK_ENABLED=1 and ORCHESTRATOR_RTK_PATH
   *  in its env, and the rtk-defer-hook.mjs variant is used (caller passes the
   *  rtk hook path via permissionHookPath). The hook calls `rtk rewrite` on Bash
   *  tool input and compresses output 60–90%. See bigchange_rtk_integration.md. */
  rtk?: {
    enabled: boolean;
    binaryPath?: string;
  };
}

/**
 * Input required event payload - for permission prompts and other input requests
 */
export interface InputRequiredPayload {
  id: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Events emitted by ClaudeCliAdapter (backward compatible)
 */
export interface ClaudeCliAdapterEvents {
  output: (message: OutputMessage) => void;
  status: (status: InstanceStatus) => void;
  context: (usage: ContextUsage) => void;
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
  spawned: (pid: number) => void;
  input_required: (payload: InputRequiredPayload) => void;
}
