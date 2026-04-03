/**
 * System Limits and Configuration Constants
 *
 * Centralizes magic numbers to improve maintainability.
 * Import from here instead of hardcoding values in individual files.
 */

export const LIMITS = {
  // Supervisor tree
  MAX_CHILDREN_PER_NODE: 12,
  MAX_RESTARTS: 5,
  RESTART_WINDOW_MS: 60000, // 1 minute

  // Output buffering
  // Increased from 1000 to 2000 to retain more context for complex tasks
  OUTPUT_BUFFER_MAX_SIZE: 2000,
  OUTPUT_BATCH_INTERVAL_MS: 50,

  // Context (conservative fallback for unknown providers; Claude-specific values in CONTEXT_WINDOWS)
  DEFAULT_MAX_CONTEXT_TOKENS: 200000,

  // Token estimation safety margin (multiplier applied to heuristic estimates)
  // Prevents overflow from inaccurate char-per-token heuristics.
  // 1.15 = 15% buffer. OpenClaw uses 1.2; we use 1.15 as a balanced choice.
  TOKEN_SAFETY_MARGIN: 1.15,

  // PTL (prompt-too-long) retry configuration
  PTL_MAX_RETRIES: 3,
  PTL_DROP_RATIO: 0.20, // Drop oldest 20% of turns per retry

  // Compaction thresholds (percentage of context window)
  COMPACTION_WARNING_THRESHOLD: 75,
  COMPACTION_BACKGROUND_THRESHOLD: 80,   // Non-blocking background compaction
  COMPACTION_BLOCKING_THRESHOLD: 95,     // Blocking — must compact before continuing
  COMPACTION_COOLDOWN_MS: 30000,         // 30s between compaction attempts

  // IPC
  IPC_TIMEOUT_MS: 30000,

  // Process pool
  MIN_WORKERS: 2,
  MAX_WORKERS: 16,

  // UI
  VIRTUAL_SCROLL_ITEM_SIZE: 72, // pixels
  FILTER_DEBOUNCE_MS: 150,

  // Activity & Status
  STATUS_DEBOUNCE_MS: 2500, // Debounce activity status updates to prevent flickering
  TEXT_THROTTLE_MS: 100,    // Throttle text streaming to 100ms batches
} as const;

/**
 * Timeout Configuration
 * Common timeout values used across the system
 */
export const TIMEOUTS = {
  // Circuit breaker and recovery
  CIRCUIT_BREAKER_RESET_MS: 30000,       // 30 seconds
  FAILURE_WINDOW_MS: 60000,              // 1 minute

  // Health checks
  HEALTH_CHECK_INTERVAL_MS: 60000,       // 1 minute
  HEALTH_CHECK_TIMEOUT_MS: 10000,        // 10 seconds

  // Standard timeouts
  SHORT_MS: 5000,                        // 5 seconds
  STANDARD_MS: 10000,                    // 10 seconds
  LONG_MS: 30000,                        // 30 seconds
  VERY_LONG_MS: 300000,                  // 5 minutes

  // Retry configuration
  CLI_CRASH_RETRY_MS: 3000,              // 3 seconds
  NETWORK_RETRY_MS: 5000,                // 5 seconds
  RATE_LIMIT_RETRY_MS: 60000,            // 1 minute
} as const;

/**
 * Model Context Windows
 * Maximum token counts for different AI models.
 *
 * Claude Code CLI default context is 200k for most models.
 * Only Opus 4.6+ and Sonnet 4.6+ natively support 1M.
 * Older models (Sonnet 4/4.5, Opus 4/4.1/4.5) require the
 * `context-1m-2025-08-07` beta header — use the `[1m]` model suffix
 * in Claude Code CLI to request it.
 *
 * See: https://github.com/anthropics/claude-code/issues/23432
 */
export const CONTEXT_WINDOWS = {
  // Claude models — Opus 4.6+ and Sonnet 4.6+ natively support 1M
  CLAUDE_DEFAULT: 200000,
  CLAUDE_OPUS: 1000000,
  CLAUDE_SONNET: 1000000,
  CLAUDE_HAIKU: 200000,

  // Claude models — 1M context (Opus 4.6+, Sonnet 4.6+, or [1m] suffix)
  CLAUDE_OPUS_1M: 1000000,
  CLAUDE_SONNET_1M: 1000000,

  // OpenAI models
  GPT4_O: 128000,
  GPT4_O_MINI: 128000,
  GPT4_TURBO: 128000,
  O1: 200000,
  O1_MINI: 128000,

  // Google Gemini models
  GEMINI_FLASH: 1000000,
  GEMINI_PRO: 2000000,

  // Limits for output
  MAX_OUTPUT_TOKENS: 4096,
  MAX_SECTION_TOKENS: 8000,
  MAX_EXPORT_TOKENS: 50000,
} as const;

/**
 * Storage and Cache Limits
 */
export const STORAGE_LIMITS = {
  // Conversation and session storage
  MAX_CONVERSATION_ENTRIES: 1000,
  MAX_STORED_SESSIONS: 10000,
  MAX_SNAPSHOTS: 50,
  MAX_LOG_ENTRIES_IN_MEMORY: 1000,

  // Cache configuration
  CACHE_ENTRIES: 1000,
  CACHE_TTL_SHORT_MS: 60000,             // 1 minute
  CACHE_TTL_MEDIUM_MS: 300000,           // 5 minutes
  CACHE_TTL_LONG_MS: 3600000,            // 1 hour
  MAX_CACHED_TOKENS: 100000,

  // Embedding service
  MAX_VOCABULARY_SIZE: 50000,
} as const;

/**
 * Memory Thresholds
 */
export const MEMORY_THRESHOLDS = {
  WARNING_MB: 1024,                      // 1 GB
  CRITICAL_MB: 1536,                     // 1.5 GB
  CHECK_INTERVAL_MS: 10000,              // 10 seconds
} as const;

/**
 * Retry Configuration
 */
export const RETRY_CONFIG = {
  MAX_ATTEMPTS_DEFAULT: 5,
  MAX_ATTEMPTS_HEALTH_CHECK: 2,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 30000,
  BACKOFF_MULTIPLIER: 2,
} as const;

/**
 * File and Input Limits
 */
export const INPUT_LIMITS = {
  MAX_COMMAND_LENGTH: 10000,
  MAX_FILE_SIZE_BYTES: 1024 * 1024,      // 1 MB
  MAX_TOOL_OUTPUT_LENGTH: 2000,
  MAX_MESSAGE_LENGTH: 500000,            // 500 KB
  MAX_ATTACHMENTS: 10,
} as const;

export const DEFAULTS = {
  INSTANCE_NAME_PREFIX: 'Instance',
  WORKING_DIRECTORY: typeof process !== 'undefined' && process.cwd ? process.cwd() : '.',
  THEME: 'system' as const,
} as const;
