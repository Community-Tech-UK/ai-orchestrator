/**
 * System Limits and Configuration Constants
 */

export const LIMITS = {
  // Supervisor tree
  MAX_CHILDREN_PER_NODE: 12,
  MAX_RESTARTS: 5,
  RESTART_WINDOW_MS: 60000, // 1 minute

  // Output buffering
  OUTPUT_BUFFER_MAX_SIZE: 1000,
  OUTPUT_BATCH_INTERVAL_MS: 50,

  // Context
  DEFAULT_MAX_CONTEXT_TOKENS: 200000,

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

export const DEFAULTS = {
  INSTANCE_NAME_PREFIX: 'Instance',
  WORKING_DIRECTORY: typeof process !== 'undefined' && process.cwd ? process.cwd() : '.',
  THEME: 'system' as const,
} as const;
