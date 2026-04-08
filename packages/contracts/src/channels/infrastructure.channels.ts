/**
 * IPC channels for application infrastructure: settings, config, app lifecycle,
 * security, cost tracking, usage stats, debug commands, structured logging,
 * and semantic search.
 */
export const INFRASTRUCTURE_CHANNELS = {
  // App operations
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_DOCS: 'app:open-docs',

  // Settings operations
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_RESET_ONE: 'settings:reset-one',
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_EXPORT: 'settings:export',
  SETTINGS_IMPORT: 'settings:import',

  // Config operations (hierarchical configuration)
  CONFIG_RESOLVE: 'config:resolve',
  CONFIG_GET_PROJECT: 'config:get-project',
  CONFIG_SAVE_PROJECT: 'config:save-project',
  CONFIG_CREATE_PROJECT: 'config:create-project',
  CONFIG_FIND_PROJECT: 'config:find-project',

  // Instruction inspection and migration
  INSTRUCTIONS_RESOLVE: 'instructions:resolve',
  INSTRUCTIONS_CREATE_DRAFT: 'instructions:create-draft',

  // Remote Configuration
  REMOTE_CONFIG_FETCH: 'remote-config:fetch',
  REMOTE_CONFIG_FETCH_URL: 'remote-config:fetch-url',
  REMOTE_CONFIG_FETCH_WELL_KNOWN: 'remote-config:fetch-well-known',
  REMOTE_CONFIG_FETCH_GITHUB: 'remote-config:fetch-github',
  REMOTE_CONFIG_DISCOVER_GIT: 'remote-config:discover-git',
  REMOTE_CONFIG_GET: 'remote-config:get',
  REMOTE_CONFIG_GET_CACHED: 'remote-config:get-cached',
  REMOTE_CONFIG_SET_SOURCE: 'remote-config:set-source',
  REMOTE_CONFIG_STATUS: 'remote-config:status',
  REMOTE_CONFIG_CLEAR_CACHE: 'remote-config:clear-cache',
  REMOTE_CONFIG_INVALIDATE: 'remote-config:invalidate',

  // Security - Secret detection and redaction
  SECURITY_DETECT_SECRETS: 'security:detect-secrets',
  SECURITY_REDACT_CONTENT: 'security:redact-content',
  SECURITY_CHECK_FILE: 'security:check-file',
  SECURITY_GET_AUDIT_LOG: 'security:get-audit-log',
  SECURITY_CLEAR_AUDIT_LOG: 'security:clear-audit-log',

  // Security - Environment filtering
  SECURITY_GET_SAFE_ENV: 'security:get-safe-env',
  SECURITY_CHECK_ENV_VAR: 'security:check-env-var',
  SECURITY_GET_ENV_FILTER_CONFIG: 'security:get-env-filter-config',
  SECURITY_UPDATE_ENV_FILTER_CONFIG: 'security:update-env-filter-config',
  SECURITY_GET_PERMISSION_CONFIG: 'security:get-permission-config',
  SECURITY_SET_PERMISSION_PRESET: 'security:set-permission-preset',

  // Cost Tracking
  COST_RECORD_USAGE: 'cost:record-usage',
  COST_GET_SUMMARY: 'cost:get-summary',
  COST_GET_HISTORY: 'cost:get-history',
  COST_GET_SESSION_COST: 'cost:get-session-cost',
  COST_GET_BUDGET: 'cost:get-budget',
  COST_SET_BUDGET: 'cost:set-budget',
  COST_GET_BUDGET_STATUS: 'cost:get-budget-status',
  COST_GET_ENTRIES: 'cost:get-entries',
  COST_CLEAR_ENTRIES: 'cost:clear-entries',
  COST_BUDGET_ALERT: 'cost:budget-alert',
  COST_USAGE_RECORDED: 'cost:usage-recorded',

  // Usage Statistics
  STATS_GET: 'stats:get',
  STATS_GET_STATS: 'stats:get-stats',
  STATS_GET_SESSION: 'stats:get-session',
  STATS_GET_ACTIVE_SESSIONS: 'stats:get-active-sessions',
  STATS_GET_TOOL_USAGE: 'stats:get-tool-usage',
  STATS_RECORD_SESSION_START: 'stats:record-session-start',
  STATS_RECORD_SESSION_END: 'stats:record-session-end',
  STATS_RECORD_MESSAGE: 'stats:record-message',
  STATS_RECORD_TOOL_USAGE: 'stats:record-tool-usage',
  STATS_EXPORT: 'stats:export',
  STATS_CLEAR: 'stats:clear',
  STATS_GET_STORAGE: 'stats:get-storage',

  // Debug Commands
  DEBUG_EXECUTE: 'debug:execute',
  DEBUG_GET_COMMANDS: 'debug:get-commands',
  DEBUG_GET_INFO: 'debug:get-info',
  DEBUG_RUN_DIAGNOSTICS: 'debug:run-diagnostics',
  DEBUG_AGENT: 'debug:agent',
  DEBUG_CONFIG: 'debug:config',
  DEBUG_FILE: 'debug:file',
  DEBUG_MEMORY: 'debug:memory',
  DEBUG_SYSTEM: 'debug:system',
  DEBUG_PROCESS: 'debug:process',
  DEBUG_ALL: 'debug:all',
  DEBUG_GET_MEMORY_HISTORY: 'debug:get-memory-history',
  DEBUG_CLEAR_MEMORY_HISTORY: 'debug:clear-memory-history',

  // Structured Logging
  LOG_MESSAGE: 'log:message',
  LOG_GET_LOGS: 'log:get-logs',
  LOG_GET_RECENT: 'log:get-recent',
  LOG_GET_CONFIG: 'log:get-config',
  LOG_SET_LEVEL: 'log:set-level',
  LOG_SET_SUBSYSTEM_LEVEL: 'log:set-subsystem-level',
  LOG_CLEAR: 'log:clear',
  LOG_CLEAR_BUFFER: 'log:clear-buffer',
  LOG_EXPORT: 'log:export',
  LOG_GET_SUBSYSTEMS: 'log:get-subsystems',
  LOG_GET_FILES: 'log:get-files',

  // Semantic Search
  SEARCH_SEMANTIC: 'search:semantic',
  SEARCH_BUILD_INDEX: 'search:build-index',
  SEARCH_CLEAR_INDEX: 'search:clear-index',
  SEARCH_GET_INDEX_STATS: 'search:get-index-stats',
  SEARCH_CONFIGURE_EXA: 'search:configure-exa',
  SEARCH_IS_EXA_CONFIGURED: 'search:is-exa-configured',

  // Recent Directories operations
  RECENT_DIRS_GET: 'recent-dirs:get',
  RECENT_DIRS_ADD: 'recent-dirs:add',
  RECENT_DIRS_REMOVE: 'recent-dirs:remove',
  RECENT_DIRS_PIN: 'recent-dirs:pin',
  RECENT_DIRS_REORDER: 'recent-dirs:reorder',
  RECENT_DIRS_CLEAR: 'recent-dirs:clear',
} as const;
