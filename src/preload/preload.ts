/**
 * Preload Script - Exposes safe IPC API to renderer
 *
 * NOTE: This file must be self-contained. Electron's sandboxed preload
 * cannot resolve imports from other directories at runtime.
 */

import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// IPC Channel names - must match main process exactly
// (Duplicated here because preload can't import from shared)
const IPC_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_CREATE_WITH_MESSAGE: 'instance:create-with-message',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_LIST: 'instance:list',

  // Instance events (main -> renderer)
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_OUTPUT: 'instance:output',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',

  // App
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_DETECT_ONE: 'cli:detect-one',
  CLI_CHECK: 'cli:check',
  CLI_TEST_CONNECTION: 'cli:test-connection',

  // Dialogs
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILES: 'dialog:select-files',

  // Settings
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',
  SETTINGS_RESET_ONE: 'settings:reset-one',
  SETTINGS_CHANGED: 'settings:changed',

  // Memory management
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_STATS_UPDATE: 'memory:stats-update',
  MEMORY_WARNING: 'memory:warning',
  MEMORY_CRITICAL: 'memory:critical',
  MEMORY_LOAD_HISTORY: 'memory:load-history',

  // History operations
  HISTORY_LIST: 'history:list',
  HISTORY_LOAD: 'history:load',
  HISTORY_DELETE: 'history:delete',
  HISTORY_RESTORE: 'history:restore',
  HISTORY_CLEAR: 'history:clear',

  // Provider operations
  PROVIDER_LIST: 'provider:list',
  PROVIDER_STATUS: 'provider:status',
  PROVIDER_STATUS_ALL: 'provider:status-all',
  PROVIDER_UPDATE_CONFIG: 'provider:update-config',

  // Session operations
  SESSION_FORK: 'session:fork',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COPY_TO_CLIPBOARD: 'session:copy-to-clipboard',
  SESSION_SAVE_TO_FILE: 'session:save-to-file',
  SESSION_REVEAL_FILE: 'session:reveal-file',

  // Command operations
  COMMAND_LIST: 'command:list',
  COMMAND_EXECUTE: 'command:execute',
  COMMAND_CREATE: 'command:create',
  COMMAND_UPDATE: 'command:update',
  COMMAND_DELETE: 'command:delete',

  // Config operations (hierarchical configuration)
  CONFIG_RESOLVE: 'config:resolve',
  CONFIG_GET_PROJECT: 'config:get-project',
  CONFIG_SAVE_PROJECT: 'config:save-project',
  CONFIG_CREATE_PROJECT: 'config:create-project',
  CONFIG_FIND_PROJECT: 'config:find-project',

  // Plan mode operations
  PLAN_MODE_ENTER: 'plan:enter',
  PLAN_MODE_EXIT: 'plan:exit',
  PLAN_MODE_APPROVE: 'plan:approve',
  PLAN_MODE_UPDATE: 'plan:update',
  PLAN_MODE_GET_STATE: 'plan:get-state',

  // VCS operations (Git)
  VCS_IS_REPO: 'vcs:is-repo',
  VCS_GET_STATUS: 'vcs:get-status',
  VCS_GET_BRANCHES: 'vcs:get-branches',
  VCS_GET_COMMITS: 'vcs:get-commits',
  VCS_GET_DIFF: 'vcs:get-diff',
  VCS_GET_FILE_HISTORY: 'vcs:get-file-history',
  VCS_GET_FILE_AT_COMMIT: 'vcs:get-file-at-commit',
  VCS_GET_BLAME: 'vcs:get-blame',

  // Snapshot operations (File revert)
  SNAPSHOT_TAKE: 'snapshot:take',
  SNAPSHOT_START_SESSION: 'snapshot:start-session',
  SNAPSHOT_END_SESSION: 'snapshot:end-session',
  SNAPSHOT_GET_FOR_INSTANCE: 'snapshot:get-for-instance',
  SNAPSHOT_GET_FOR_FILE: 'snapshot:get-for-file',
  SNAPSHOT_GET_SESSIONS: 'snapshot:get-sessions',
  SNAPSHOT_GET_CONTENT: 'snapshot:get-content',
  SNAPSHOT_REVERT_FILE: 'snapshot:revert-file',
  SNAPSHOT_REVERT_SESSION: 'snapshot:revert-session',
  SNAPSHOT_GET_DIFF: 'snapshot:get-diff',
  SNAPSHOT_DELETE: 'snapshot:delete',
  SNAPSHOT_CLEANUP: 'snapshot:cleanup',
  SNAPSHOT_GET_STATS: 'snapshot:get-stats',

  // TODO operations
  TODO_GET_LIST: 'todo:get-list',
  TODO_CREATE: 'todo:create',
  TODO_UPDATE: 'todo:update',
  TODO_DELETE: 'todo:delete',
  TODO_WRITE_ALL: 'todo:write-all',
  TODO_CLEAR: 'todo:clear',
  TODO_GET_CURRENT: 'todo:get-current',
  TODO_LIST_CHANGED: 'todo:list-changed',

  // MCP operations
  MCP_GET_STATE: 'mcp:get-state',
  MCP_GET_SERVERS: 'mcp:get-servers',
  MCP_ADD_SERVER: 'mcp:add-server',
  MCP_REMOVE_SERVER: 'mcp:remove-server',
  MCP_CONNECT: 'mcp:connect',
  MCP_DISCONNECT: 'mcp:disconnect',
  MCP_RESTART: 'mcp:restart',
  MCP_GET_TOOLS: 'mcp:get-tools',
  MCP_GET_RESOURCES: 'mcp:get-resources',
  MCP_GET_PROMPTS: 'mcp:get-prompts',
  MCP_CALL_TOOL: 'mcp:call-tool',
  MCP_READ_RESOURCE: 'mcp:read-resource',
  MCP_GET_PROMPT: 'mcp:get-prompt',
  MCP_GET_PRESETS: 'mcp:get-presets',
  MCP_STATE_CHANGED: 'mcp:state-changed',
  MCP_SERVER_STATUS_CHANGED: 'mcp:server-status-changed',

  // LSP operations
  LSP_GET_AVAILABLE_SERVERS: 'lsp:get-available-servers',
  LSP_GET_STATUS: 'lsp:get-status',
  LSP_GO_TO_DEFINITION: 'lsp:go-to-definition',
  LSP_FIND_REFERENCES: 'lsp:find-references',
  LSP_HOVER: 'lsp:hover',
  LSP_DOCUMENT_SYMBOLS: 'lsp:document-symbols',
  LSP_WORKSPACE_SYMBOLS: 'lsp:workspace-symbols',
  LSP_DIAGNOSTICS: 'lsp:diagnostics',
  LSP_IS_AVAILABLE: 'lsp:is-available',
  LSP_SHUTDOWN: 'lsp:shutdown',

  // Multi-Edit operations
  MULTIEDIT_PREVIEW: 'multiedit:preview',
  MULTIEDIT_APPLY: 'multiedit:apply',

  // Bash validation operations
  BASH_VALIDATE: 'bash:validate',
  BASH_GET_CONFIG: 'bash:get-config',
  BASH_ADD_ALLOWED: 'bash:add-allowed',
  BASH_ADD_BLOCKED: 'bash:add-blocked',

  // Task management (subagent spawning)
  TASK_GET_STATUS: 'task:get-status',
  TASK_GET_HISTORY: 'task:get-history',
  TASK_GET_BY_PARENT: 'task:get-by-parent',
  TASK_GET_BY_CHILD: 'task:get-by-child',
  TASK_CANCEL: 'task:cancel',
  TASK_GET_QUEUE: 'task:get-queue',

  // Security - Secret detection & redaction
  SECURITY_DETECT_SECRETS: 'security:detect-secrets',
  SECURITY_REDACT_CONTENT: 'security:redact-content',
  SECURITY_CHECK_FILE: 'security:check-file',
  SECURITY_GET_AUDIT_LOG: 'security:get-audit-log',
  SECURITY_CLEAR_AUDIT_LOG: 'security:clear-audit-log',

  // Security - Environment filtering
  SECURITY_GET_SAFE_ENV: 'security:get-safe-env',
  SECURITY_CHECK_ENV_VAR: 'security:check-env-var',
  SECURITY_GET_ENV_FILTER_CONFIG: 'security:get-env-filter-config',

  // Cost Tracking (5.3)
  COST_RECORD_USAGE: 'cost:record-usage',
  COST_GET_SUMMARY: 'cost:get-summary',
  COST_GET_HISTORY: 'cost:get-history',
  COST_SET_BUDGET: 'cost:set-budget',
  COST_GET_BUDGET_STATUS: 'cost:get-budget-status',

  // Session Archive (1.3)
  ARCHIVE_SESSION: 'archive:session',
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_RESTORE: 'archive:restore',
  ARCHIVE_DELETE: 'archive:delete',
  ARCHIVE_SEARCH: 'archive:search',

  // Remote Config (6.2)
  REMOTE_CONFIG_FETCH: 'remote-config:fetch',
  REMOTE_CONFIG_GET: 'remote-config:get',
  REMOTE_CONFIG_SET_SOURCE: 'remote-config:set-source',
  REMOTE_CONFIG_STATUS: 'remote-config:status',

  // External Editor (9.2)
  EDITOR_OPEN: 'editor:open',
  EDITOR_GET_AVAILABLE: 'editor:get-available',
  EDITOR_SET_DEFAULT: 'editor:set-default',
  EDITOR_GET_DEFAULT: 'editor:get-default',

  // File Watcher (10.1)
  WATCHER_WATCH: 'watcher:watch',
  WATCHER_UNWATCH: 'watcher:unwatch',
  WATCHER_GET_ACTIVE: 'watcher:get-active',

  // Logging (13.1)
  LOG_MESSAGE: 'log:message',
  LOG_GET_LOGS: 'log:get-logs',
  LOG_SET_LEVEL: 'log:set-level',
  LOG_EXPORT: 'log:export',
  LOG_CLEAR: 'log:clear',

  // Debug Commands (13.2)
  DEBUG_EXECUTE: 'debug:execute',
  DEBUG_GET_COMMANDS: 'debug:get-commands',
  DEBUG_GET_INFO: 'debug:get-info',
  DEBUG_RUN_DIAGNOSTICS: 'debug:run-diagnostics',

  // Usage Stats (14.1)
  STATS_RECORD_SESSION_START: 'stats:record-session-start',
  STATS_RECORD_SESSION_END: 'stats:record-session-end',
  STATS_RECORD_MESSAGE: 'stats:record-message',
  STATS_RECORD_TOOL_USAGE: 'stats:record-tool-usage',
  STATS_GET_STATS: 'stats:get-stats',
  STATS_EXPORT: 'stats:export',

  // Semantic Search (4.7)
  SEARCH_SEMANTIC: 'search:semantic',
  SEARCH_BUILD_INDEX: 'search:build-index',
  SEARCH_CONFIGURE_EXA: 'search:configure-exa',
  SEARCH_GET_INDEX_STATS: 'search:get-index-stats',

  // Provider Plugins (12.2)
  PLUGINS_DISCOVER: 'plugins:discover',
  PLUGINS_LOAD: 'plugins:load',
  PLUGINS_UNLOAD: 'plugins:unload',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_GET_LOADED: 'plugins:get-loaded',
  PLUGINS_CREATE_TEMPLATE: 'plugins:create-template',

  // Phase 6: Workflows (6.1)
  WORKFLOW_LIST_TEMPLATES: 'workflow:list-templates',
  WORKFLOW_GET_TEMPLATE: 'workflow:get-template',
  WORKFLOW_START: 'workflow:start',
  WORKFLOW_GET_EXECUTION: 'workflow:get-execution',
  WORKFLOW_GET_BY_INSTANCE: 'workflow:get-by-instance',
  WORKFLOW_COMPLETE_PHASE: 'workflow:complete-phase',
  WORKFLOW_SATISFY_GATE: 'workflow:satisfy-gate',
  WORKFLOW_SKIP_PHASE: 'workflow:skip-phase',
  WORKFLOW_CANCEL: 'workflow:cancel',
  WORKFLOW_GET_PROMPT_ADDITION: 'workflow:get-prompt-addition',

  // Phase 6: Review Agents (6.2)
  REVIEW_LIST_AGENTS: 'review:list-agents',
  REVIEW_GET_AGENT: 'review:get-agent',

  // Phase 6: Hooks (6.3)
  HOOKS_LIST: 'hooks:list',
  HOOKS_GET: 'hooks:get',
  HOOKS_CREATE: 'hooks:create',
  HOOKS_UPDATE: 'hooks:update',
  HOOKS_DELETE: 'hooks:delete',
  HOOKS_EVALUATE: 'hooks:evaluate',
  HOOKS_IMPORT: 'hooks:import',
  HOOKS_EXPORT: 'hooks:export',

  // Phase 6: Skills (6.4)
  SKILLS_DISCOVER: 'skills:discover',
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_LOAD: 'skills:load',
  SKILLS_UNLOAD: 'skills:unload',
  SKILLS_LOAD_REFERENCE: 'skills:load-reference',
  SKILLS_LOAD_EXAMPLE: 'skills:load-example',
  SKILLS_MATCH: 'skills:match',
  SKILLS_GET_MEMORY: 'skills:get-memory',

  // Phase 7: Worktrees (7.1)
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_DELETE: 'worktree:delete',
  WORKTREE_GET_STATUS: 'worktree:get-status',

  // Phase 7: Specialists (7.4)
  SPECIALIST_LIST: 'specialist:list',
  SPECIALIST_LIST_BUILTIN: 'specialist:list-builtin',
  SPECIALIST_LIST_CUSTOM: 'specialist:list-custom',
  SPECIALIST_GET: 'specialist:get',
  SPECIALIST_GET_BY_CATEGORY: 'specialist:get-by-category',
  SPECIALIST_ADD_CUSTOM: 'specialist:add-custom',
  SPECIALIST_UPDATE_CUSTOM: 'specialist:update-custom',
  SPECIALIST_REMOVE_CUSTOM: 'specialist:remove-custom',
  SPECIALIST_RECOMMEND: 'specialist:recommend',
  SPECIALIST_CREATE_INSTANCE: 'specialist:create-instance',
  SPECIALIST_GET_INSTANCE: 'specialist:get-instance',
  SPECIALIST_GET_ACTIVE_INSTANCES: 'specialist:get-active-instances',
  SPECIALIST_UPDATE_STATUS: 'specialist:update-status',
  SPECIALIST_ADD_FINDING: 'specialist:add-finding',
  SPECIALIST_UPDATE_METRICS: 'specialist:update-metrics',
  SPECIALIST_GET_PROMPT_ADDITION: 'specialist:get-prompt-addition',

  // Phase 7: Supervision (7.3)
  SUPERVISION_GET_TREE: 'supervision:get-tree',
  SUPERVISION_GET_HEALTH: 'supervision:get-health',

  // Phase 8: RLM Context (8.1)
  RLM_RECORD_OUTCOME: 'rlm:record-outcome',
  RLM_GET_PATTERNS: 'rlm:get-patterns',
  RLM_GET_STRATEGY_SUGGESTIONS: 'rlm:get-strategy-suggestions',

  // Phase 9: Memory-R1 (9.1)
  MEMORY_R1_DECIDE_OPERATION: 'memory-r1:decide-operation',
  MEMORY_R1_EXECUTE_OPERATION: 'memory-r1:execute-operation',
  MEMORY_R1_ADD_ENTRY: 'memory-r1:add-entry',
  MEMORY_R1_DELETE_ENTRY: 'memory-r1:delete-entry',
  MEMORY_R1_GET_ENTRY: 'memory-r1:get-entry',
  MEMORY_R1_RETRIEVE: 'memory-r1:retrieve',
  MEMORY_R1_RECORD_OUTCOME: 'memory-r1:record-outcome',
  MEMORY_R1_GET_STATS: 'memory-r1:get-stats',
  MEMORY_R1_SAVE: 'memory-r1:save',
  MEMORY_R1_LOAD: 'memory-r1:load',
  MEMORY_R1_CONFIGURE: 'memory-r1:configure',

  // Phase 9: Unified Memory (9.2)
  UNIFIED_MEMORY_PROCESS_INPUT: 'unified-memory:process-input',
  UNIFIED_MEMORY_RETRIEVE: 'unified-memory:retrieve',
  UNIFIED_MEMORY_RECORD_SESSION_END: 'unified-memory:record-session-end',
  UNIFIED_MEMORY_RECORD_WORKFLOW: 'unified-memory:record-workflow',
  UNIFIED_MEMORY_RECORD_STRATEGY: 'unified-memory:record-strategy',
  UNIFIED_MEMORY_RECORD_OUTCOME: 'unified-memory:record-outcome',
  UNIFIED_MEMORY_GET_STATS: 'unified-memory:get-stats',
  UNIFIED_MEMORY_GET_SESSIONS: 'unified-memory:get-sessions',
  UNIFIED_MEMORY_GET_PATTERNS: 'unified-memory:get-patterns',
  UNIFIED_MEMORY_GET_WORKFLOWS: 'unified-memory:get-workflows',
  UNIFIED_MEMORY_SAVE: 'unified-memory:save',
  UNIFIED_MEMORY_LOAD: 'unified-memory:load',
  UNIFIED_MEMORY_CONFIGURE: 'unified-memory:configure',

  // Phase 9: Debate (9.3)
  DEBATE_START: 'debate:start',
  DEBATE_GET_RESULT: 'debate:get-result',
  DEBATE_GET_ACTIVE: 'debate:get-active',
  DEBATE_CANCEL: 'debate:cancel',
  DEBATE_GET_STATS: 'debate:get-stats',

  // Phase 9: Training (9.4)
  TRAINING_RECORD_OUTCOME: 'training:record-outcome',
  TRAINING_GET_STATS: 'training:get-stats',
  TRAINING_EXPORT_DATA: 'training:export-data',
  TRAINING_IMPORT_DATA: 'training:import-data',
  TRAINING_GET_TREND: 'training:get-trend',
  TRAINING_GET_TOP_STRATEGIES: 'training:get-top-strategies',
  TRAINING_CONFIGURE: 'training:configure',

  // Phase 8: Learning (8.2)
  LEARNING_RECORD_OUTCOME: 'learning:record-outcome',
  LEARNING_GET_PATTERNS: 'learning:get-patterns',
  LEARNING_GET_SUGGESTIONS: 'learning:get-suggestions',
  LEARNING_ENHANCE_PROMPT: 'learning:enhance-prompt',

  // Phase 8: Verification (8.3)
  VERIFICATION_VERIFY_MULTI: 'verification:verify-multi',
  VERIFICATION_START_CLI: 'verification:start-cli',
  VERIFICATION_CANCEL: 'verification:cancel',
  VERIFICATION_GET_ACTIVE: 'verification:get-active',
  VERIFICATION_GET_RESULT: 'verification:get-result',
} as const;

// Response type
interface IpcResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}

/**
 * Electron API exposed to renderer
 */
const electronAPI = {
  // ============================================
  // Instance Management
  // ============================================

  /**
   * Create a new Claude instance
   */
  createInstance: (payload: {
    workingDirectory: string;
    sessionId?: string;
    parentInstanceId?: string;
    displayName?: string;
    initialPrompt?: string;
    attachments?: unknown[];
    yoloMode?: boolean;
    agentId?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_CREATE, payload);
  },

  /**
   * Create a new Claude instance and immediately send a message
   */
  createInstanceWithMessage: (payload: {
    workingDirectory: string;
    message: string;
    attachments?: unknown[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_CREATE_WITH_MESSAGE, payload);
  },

  /**
   * Send input to an instance
   */
  sendInput: (payload: {
    instanceId: string;
    message: string;
    attachments?: unknown[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_SEND_INPUT, payload);
  },

  /**
   * Terminate an instance
   */
  terminateInstance: (payload: {
    instanceId: string;
    graceful?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_TERMINATE, payload);
  },

  /**
   * Interrupt an instance (Ctrl+C equivalent)
   * Sends SIGINT to pause the current operation without terminating
   */
  interruptInstance: (payload: {
    instanceId: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_INTERRUPT, payload);
  },

  /**
   * Restart an instance
   */
  restartInstance: (payload: {
    instanceId: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_RESTART, payload);
  },

  /**
   * Rename an instance
   */
  renameInstance: (payload: {
    instanceId: string;
    displayName: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_RENAME, payload);
  },

  /**
   * Terminate all instances
   */
  terminateAllInstances: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_TERMINATE_ALL);
  },

  /**
   * Get all instances
   */
  listInstances: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_LIST);
  },

  // ============================================
  // Event Listeners
  // ============================================

  /**
   * Listen for instance created events
   */
  onInstanceCreated: (callback: (instance: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, instance: unknown) => callback(instance);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_CREATED, handler);
  },

  /**
   * Listen for instance removed events
   */
  onInstanceRemoved: (callback: (instanceId: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, instanceId: string) => callback(instanceId);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_REMOVED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_REMOVED, handler);
  },

  /**
   * Listen for instance state updates
   */
  onInstanceStateUpdate: (callback: (update: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, update: unknown) => callback(update);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_STATE_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_STATE_UPDATE, handler);
  },

  /**
   * Listen for instance output
   */
  onInstanceOutput: (callback: (output: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, output: unknown) => callback(output);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_OUTPUT, handler);
  },

  /**
   * Listen for batch updates
   */
  onBatchUpdate: (callback: (batch: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, batch: unknown) => callback(batch);
    ipcRenderer.on(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INSTANCE_BATCH_UPDATE, handler);
  },

  // ============================================
  // App
  // ============================================

  /**
   * Signal app ready
   */
  appReady: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_READY);
  },

  /**
   * Get app version
   */
  getVersion: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION);
  },

  // ============================================
  // CLI Detection
  // ============================================

  /**
   * Detect all available CLIs
   */
  detectClis: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_DETECT_ALL);
  },

  /**
   * Detect a single CLI by command
   */
  detectOneCli: (command: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_DETECT_ONE, { command });
  },

  /**
   * Check if a specific CLI is available
   */
  checkCli: (cliType: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_CHECK, cliType);
  },

  /**
   * Test connection to a CLI
   */
  testCliConnection: (command: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLI_TEST_CONNECTION, { command });
  },

  // ============================================
  // Dialogs
  // ============================================

  /**
   * Open folder selection dialog
   * Returns the selected folder path or null if cancelled
   */
  selectFolder: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER);
  },

  /**
   * Open file selection dialog
   * Returns the selected file paths or null if cancelled
   */
  selectFiles: (options?: { multiple?: boolean; filters?: { name: string; extensions: string[] }[] }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILES, options);
  },

  // ============================================
  // Settings
  // ============================================

  /**
   * Get all settings
   */
  getSettings: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_ALL);
  },

  /**
   * Get a single setting
   */
  getSetting: (key: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key);
  },

  /**
   * Set a single setting
   */
  setSetting: (key: string, value: unknown): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value });
  },

  /**
   * Update multiple settings
   */
  updateSettings: (settings: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, { settings });
  },

  /**
   * Reset all settings to defaults
   */
  resetSettings: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET);
  },

  /**
   * Reset a single setting to default
   */
  resetSetting: (key: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_RESET_ONE, { key });
  },

  /**
   * Listen for settings changes
   */
  onSettingsChanged: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, handler);
  },

  // ============================================
  // Memory Management
  // ============================================

  /**
   * Get current memory stats
   */
  getMemoryStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_STATS);
  },

  /**
   * Load historical output from disk for an instance
   */
  loadHistoricalOutput: (instanceId: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_LOAD_HISTORY, { instanceId, limit });
  },

  /**
   * Listen for memory stats updates
   */
  onMemoryStatsUpdate: (callback: (stats: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, stats: unknown) => callback(stats);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_STATS_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_STATS_UPDATE, handler);
  },

  /**
   * Listen for memory warnings
   */
  onMemoryWarning: (callback: (warning: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, warning: unknown) => callback(warning);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_WARNING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_WARNING, handler);
  },

  /**
   * Listen for critical memory alerts
   */
  onMemoryCritical: (callback: (alert: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, alert: unknown) => callback(alert);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_CRITICAL, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_CRITICAL, handler);
  },

  // ============================================
  // History
  // ============================================

  /**
   * Get history entries
   */
  listHistory: (options?: {
    limit?: number;
    searchQuery?: string;
    workingDirectory?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_LIST, options || {});
  },

  /**
   * Load full conversation data for a history entry
   */
  loadHistoryEntry: (entryId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_LOAD, { entryId });
  },

  /**
   * Delete a history entry
   */
  deleteHistoryEntry: (entryId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_DELETE, { entryId });
  },

  /**
   * Restore a conversation from history as a new instance
   */
  restoreHistory: (entryId: string, workingDirectory?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_RESTORE, { entryId, workingDirectory });
  },

  /**
   * Clear all history
   */
  clearHistory: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HISTORY_CLEAR);
  },

  // ============================================
  // Providers
  // ============================================

  /**
   * List all provider configurations
   */
  listProviders: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST);
  },

  /**
   * Get status of a specific provider
   */
  getProviderStatus: (providerType: string, forceRefresh?: boolean): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_STATUS, { providerType, forceRefresh });
  },

  /**
   * Get status of all providers
   */
  getAllProviderStatus: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_STATUS_ALL);
  },

  /**
   * Update provider configuration
   */
  updateProviderConfig: (providerType: string, config: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_UPDATE_CONFIG, { providerType, config });
  },

  // ============================================
  // Session Operations
  // ============================================

  /**
   * Fork a session at a specific message point
   */
  forkSession: (payload: {
    instanceId: string;
    atMessageIndex?: number;
    displayName?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_FORK, payload);
  },

  /**
   * Export a session to JSON or Markdown
   */
  exportSession: (payload: {
    instanceId: string;
    format: 'json' | 'markdown';
    includeMetadata?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_EXPORT, payload);
  },

  /**
   * Import a session from a file
   */
  importSession: (payload: {
    filePath: string;
    workingDirectory?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_IMPORT, payload);
  },

  /**
   * Copy session to clipboard
   */
  copySessionToClipboard: (payload: {
    instanceId: string;
    format: 'json' | 'markdown';
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_COPY_TO_CLIPBOARD, payload);
  },

  /**
   * Save session to file
   */
  saveSessionToFile: (payload: {
    instanceId: string;
    format: 'json' | 'markdown';
    filePath?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_SAVE_TO_FILE, payload);
  },

  /**
   * Reveal a file in the system file manager
   */
  revealFile: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SESSION_REVEAL_FILE, { filePath });
  },

  // ============================================
  // Command Operations
  // ============================================

  /**
   * List all commands (built-in + custom)
   */
  listCommands: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_LIST);
  },

  /**
   * Execute a command
   */
  executeCommand: (payload: {
    commandId: string;
    instanceId: string;
    args?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_EXECUTE, payload);
  },

  /**
   * Create a custom command
   */
  createCommand: (payload: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_CREATE, payload);
  },

  /**
   * Update a custom command
   */
  updateCommand: (payload: {
    commandId: string;
    updates: Partial<{
      name: string;
      description: string;
      template: string;
      hint: string;
    }>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_UPDATE, payload);
  },

  /**
   * Delete a custom command
   */
  deleteCommand: (commandId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COMMAND_DELETE, { commandId });
  },

  // ============================================
  // Configuration (Hierarchical)
  // ============================================

  /**
   * Resolve configuration for a working directory
   * Returns merged config with source tracking (project > user > default)
   */
  resolveConfig: (workingDirectory?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_RESOLVE, { workingDirectory });
  },

  /**
   * Get project config from a specific path
   */
  getProjectConfig: (configPath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET_PROJECT, { configPath });
  },

  /**
   * Save project config to a specific path
   */
  saveProjectConfig: (configPath: string, config: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE_PROJECT, { configPath, config });
  },

  /**
   * Create a new project config file
   */
  createProjectConfig: (projectDir: string, config?: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_CREATE_PROJECT, { projectDir, config });
  },

  /**
   * Find project config path by searching up the directory tree
   */
  findProjectConfig: (startDir: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CONFIG_FIND_PROJECT, { startDir });
  },

  // ============================================
  // Plan Mode
  // ============================================

  /**
   * Enter plan mode (read-only exploration)
   */
  enterPlanMode: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_MODE_ENTER, { instanceId });
  },

  /**
   * Exit plan mode
   */
  exitPlanMode: (instanceId: string, force?: boolean): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_MODE_EXIT, { instanceId, force });
  },

  /**
   * Approve a plan (allows transition to implementation)
   */
  approvePlan: (instanceId: string, planContent?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_MODE_APPROVE, { instanceId, planContent });
  },

  /**
   * Update plan content
   */
  updatePlanContent: (instanceId: string, planContent: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_MODE_UPDATE, { instanceId, planContent });
  },

  /**
   * Get plan mode state
   */
  getPlanModeState: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLAN_MODE_GET_STATE, { instanceId });
  },

  // ============================================
  // VCS (Git) Operations
  // ============================================

  /**
   * Check if working directory is a git repository
   */
  vcsIsRepo: (workingDirectory: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_IS_REPO, { workingDirectory });
  },

  /**
   * Get git status for working directory
   */
  vcsGetStatus: (workingDirectory: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_STATUS, { workingDirectory });
  },

  /**
   * Get branches for working directory
   */
  vcsGetBranches: (workingDirectory: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_BRANCHES, { workingDirectory });
  },

  /**
   * Get recent commits
   */
  vcsGetCommits: (workingDirectory: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_COMMITS, { workingDirectory, limit });
  },

  /**
   * Get diff (staged, unstaged, or between refs)
   */
  vcsGetDiff: (payload: {
    workingDirectory: string;
    type: 'staged' | 'unstaged' | 'between';
    fromRef?: string;
    toRef?: string;
    filePath?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_DIFF, payload);
  },

  /**
   * Get file history (commits that modified the file)
   */
  vcsGetFileHistory: (workingDirectory: string, filePath: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_FILE_HISTORY, { workingDirectory, filePath, limit });
  },

  /**
   * Get file content at a specific commit
   */
  vcsGetFileAtCommit: (workingDirectory: string, filePath: string, commitHash: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_FILE_AT_COMMIT, { workingDirectory, filePath, commitHash });
  },

  /**
   * Get blame information for a file
   */
  vcsGetBlame: (workingDirectory: string, filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VCS_GET_BLAME, { workingDirectory, filePath });
  },

  // ============================================
  // Snapshot Operations (File Revert)
  // ============================================

  /**
   * Take a snapshot before file modification
   */
  snapshotTake: (payload: {
    filePath: string;
    instanceId: string;
    sessionId?: string;
    action?: 'create' | 'modify' | 'delete';
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_TAKE, payload);
  },

  /**
   * Start a snapshot session
   */
  snapshotStartSession: (instanceId: string, description?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_START_SESSION, { instanceId, description });
  },

  /**
   * End a snapshot session
   */
  snapshotEndSession: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_END_SESSION, { sessionId });
  },

  /**
   * Get all snapshots for an instance
   */
  snapshotGetForInstance: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_FOR_INSTANCE, { instanceId });
  },

  /**
   * Get all snapshots for a file
   */
  snapshotGetForFile: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_FOR_FILE, { filePath });
  },

  /**
   * Get all sessions for an instance
   */
  snapshotGetSessions: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_SESSIONS, { instanceId });
  },

  /**
   * Get content from a snapshot
   */
  snapshotGetContent: (snapshotId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_CONTENT, { snapshotId });
  },

  /**
   * Revert a file to a specific snapshot
   */
  snapshotRevertFile: (snapshotId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_REVERT_FILE, { snapshotId });
  },

  /**
   * Revert all files in a session
   */
  snapshotRevertSession: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_REVERT_SESSION, { sessionId });
  },

  /**
   * Get diff between snapshot and current file
   */
  snapshotGetDiff: (snapshotId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_DIFF, { snapshotId });
  },

  /**
   * Delete a snapshot
   */
  snapshotDelete: (snapshotId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_DELETE, { snapshotId });
  },

  /**
   * Cleanup old snapshots
   */
  snapshotCleanup: (maxAgeDays?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_CLEANUP, { maxAgeDays });
  },

  /**
   * Get snapshot storage stats
   */
  snapshotGetStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_GET_STATS);
  },

  // ============================================
  // TODO Operations
  // ============================================

  /**
   * Get TODO list for a session
   */
  todoGetList: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_GET_LIST, { sessionId });
  },

  /**
   * Create a new TODO
   */
  todoCreate: (payload: {
    sessionId: string;
    content: string;
    activeForm?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    parentId?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_CREATE, payload);
  },

  /**
   * Update a TODO
   */
  todoUpdate: (payload: {
    sessionId: string;
    todoId: string;
    content?: string;
    activeForm?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_UPDATE, payload);
  },

  /**
   * Delete a TODO
   */
  todoDelete: (sessionId: string, todoId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_DELETE, { sessionId, todoId });
  },

  /**
   * Write all TODOs at once (replaces existing)
   * This matches Claude's TodoWrite tool format
   */
  todoWriteAll: (payload: {
    sessionId: string;
    todos: Array<{
      content: string;
      status: string;
      activeForm?: string;
    }>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_WRITE_ALL, payload);
  },

  /**
   * Clear all TODOs for a session
   */
  todoClear: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_CLEAR, { sessionId });
  },

  /**
   * Get the current in-progress TODO
   */
  todoGetCurrent: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TODO_GET_CURRENT, { sessionId });
  },

  /**
   * Listen for TODO list changes
   */
  onTodoListChanged: (callback: (data: { sessionId: string; list: unknown }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { sessionId: string; list: unknown }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TODO_LIST_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TODO_LIST_CHANGED, handler);
  },

  // ============================================
  // MCP Operations
  // ============================================

  /**
   * Get full MCP state (servers, tools, resources, prompts)
   */
  mcpGetState: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_STATE);
  },

  /**
   * Get all MCP servers
   */
  mcpGetServers: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVERS);
  },

  /**
   * Add an MCP server
   */
  mcpAddServer: (payload: {
    id: string;
    name: string;
    description?: string;
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    autoConnect?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, payload);
  },

  /**
   * Remove an MCP server
   */
  mcpRemoveServer: (serverId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, { serverId });
  },

  /**
   * Connect to an MCP server
   */
  mcpConnect: (serverId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT, { serverId });
  },

  /**
   * Disconnect from an MCP server
   */
  mcpDisconnect: (serverId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT, { serverId });
  },

  /**
   * Restart an MCP server connection
   */
  mcpRestart: (serverId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_RESTART, { serverId });
  },

  /**
   * Get all MCP tools
   */
  mcpGetTools: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_TOOLS);
  },

  /**
   * Get all MCP resources
   */
  mcpGetResources: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_RESOURCES);
  },

  /**
   * Get all MCP prompts
   */
  mcpGetPrompts: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_PROMPTS);
  },

  /**
   * Call an MCP tool
   */
  mcpCallTool: (payload: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_CALL_TOOL, payload);
  },

  /**
   * Read an MCP resource
   */
  mcpReadResource: (payload: {
    serverId: string;
    uri: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_READ_RESOURCE, payload);
  },

  /**
   * Get an MCP prompt
   */
  mcpGetPrompt: (payload: {
    serverId: string;
    promptName: string;
    arguments?: Record<string, string>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_PROMPT, payload);
  },

  /**
   * Get MCP server presets
   */
  mcpGetPresets: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_PRESETS);
  },

  /**
   * Listen for MCP state changes (tools, resources, prompts updated)
   */
  onMcpStateChanged: (callback: (data: { type: string; serverId?: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { type: string; serverId?: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MCP_STATE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_STATE_CHANGED, handler);
  },

  /**
   * Listen for MCP server status changes
   */
  onMcpServerStatusChanged: (callback: (data: { serverId: string; status: string; error?: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { serverId: string; status: string; error?: string }) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, handler);
  },

  // ============================================
  // LSP Operations
  // ============================================

  /**
   * Get available LSP servers (installed language servers)
   */
  lspGetAvailableServers: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_GET_AVAILABLE_SERVERS);
  },

  /**
   * Get status of all active LSP clients
   */
  lspGetStatus: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_GET_STATUS);
  },

  /**
   * Go to definition (navigate to where symbol is defined)
   */
  lspGoToDefinition: (payload: {
    filePath: string;
    line: number;
    character: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_GO_TO_DEFINITION, payload);
  },

  /**
   * Find all references to a symbol
   */
  lspFindReferences: (payload: {
    filePath: string;
    line: number;
    character: number;
    includeDeclaration?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_FIND_REFERENCES, payload);
  },

  /**
   * Get hover information (type info, documentation)
   */
  lspHover: (payload: {
    filePath: string;
    line: number;
    character: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_HOVER, payload);
  },

  /**
   * Get document symbols (outline/structure)
   */
  lspDocumentSymbols: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_DOCUMENT_SYMBOLS, { filePath });
  },

  /**
   * Search workspace symbols
   */
  lspWorkspaceSymbols: (query: string, rootPath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_WORKSPACE_SYMBOLS, { query, rootPath });
  },

  /**
   * Get diagnostics (errors, warnings) for a file
   */
  lspDiagnostics: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_DIAGNOSTICS, { filePath });
  },

  /**
   * Check if LSP is available for a file type
   */
  lspIsAvailable: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_IS_AVAILABLE, { filePath });
  },

  /**
   * Shutdown all LSP clients
   */
  lspShutdown: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LSP_SHUTDOWN);
  },

  // ============================================
  // Multi-Edit Operations
  // ============================================

  /**
   * Preview edits without applying them
   */
  multiEditPreview: (payload: {
    edits: Array<{
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MULTIEDIT_PREVIEW, payload);
  },

  /**
   * Apply edits atomically (all succeed or all fail)
   */
  multiEditApply: (payload: {
    edits: Array<{
      filePath: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
    }>;
    instanceId?: string;
    takeSnapshots?: boolean;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MULTIEDIT_APPLY, payload);
  },

  // ============================================
  // Bash Validation
  // ============================================

  /**
   * Validate a bash command for safety
   */
  bashValidate: (command: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.BASH_VALIDATE, command);
  },

  /**
   * Get bash validator configuration
   */
  bashGetConfig: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.BASH_GET_CONFIG);
  },

  /**
   * Add a command to the allowed list
   */
  bashAddAllowed: (command: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.BASH_ADD_ALLOWED, command);
  },

  /**
   * Add a command to the blocked list
   */
  bashAddBlocked: (command: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.BASH_ADD_BLOCKED, command);
  },

  // ============================================
  // Task Management (Subagent Spawning)
  // ============================================

  /**
   * Get task status by ID
   */
  taskGetStatus: (taskId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_STATUS, { taskId });
  },

  /**
   * Get task history
   */
  taskGetHistory: (parentId?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_HISTORY, { parentId });
  },

  /**
   * Get tasks by parent instance
   */
  taskGetByParent: (parentId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_BY_PARENT, { parentId });
  },

  /**
   * Get task by child instance
   */
  taskGetByChild: (childId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_BY_CHILD, { childId });
  },

  /**
   * Cancel a task
   */
  taskCancel: (taskId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, { taskId });
  },

  /**
   * Get task queue stats
   */
  taskGetQueue: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_QUEUE);
  },

  // ============================================
  // Security - Secret Detection & Redaction
  // ============================================

  /**
   * Detect secrets in content
   */
  securityDetectSecrets: (content: string, contentType?: 'env' | 'text' | 'auto'): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_DETECT_SECRETS, { content, contentType });
  },

  /**
   * Redact secrets in content
   */
  securityRedactContent: (
    content: string,
    contentType?: 'env' | 'text' | 'auto',
    options?: { maskChar?: string; showStart?: number; showEnd?: number; fullMask?: boolean; label?: string }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_REDACT_CONTENT, { content, contentType, options });
  },

  /**
   * Check if a file path is sensitive
   */
  securityCheckFile: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_CHECK_FILE, { filePath });
  },

  /**
   * Get secret access audit log
   */
  securityGetAuditLog: (instanceId?: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_AUDIT_LOG, { instanceId, limit });
  },

  /**
   * Clear audit log
   */
  securityClearAuditLog: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_CLEAR_AUDIT_LOG);
  },

  /**
   * Get safe environment variables
   */
  securityGetSafeEnv: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_SAFE_ENV);
  },

  /**
   * Check if a single env var should be allowed
   */
  securityCheckEnvVar: (name: string, value: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_CHECK_ENV_VAR, { name, value });
  },

  /**
   * Get env filter config
   */
  securityGetEnvFilterConfig: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SECURITY_GET_ENV_FILTER_CONFIG);
  },

  // ============================================
  // Cost Tracking (5.3)
  // ============================================

  /**
   * Record token usage and cost
   */
  costRecordUsage: (
    instanceId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COST_RECORD_USAGE, {
      instanceId,
      provider,
      model,
      inputTokens,
      outputTokens,
    });
  },

  /**
   * Get cost summary
   */
  costGetSummary: (instanceId?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COST_GET_SUMMARY, { instanceId });
  },

  /**
   * Get cost history
   */
  costGetHistory: (instanceId?: string, limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COST_GET_HISTORY, { instanceId, limit });
  },

  /**
   * Set budget limits
   */
  costSetBudget: (budget: {
    daily?: number;
    weekly?: number;
    monthly?: number;
    warningThreshold?: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COST_SET_BUDGET, { budget });
  },

  /**
   * Get current budget status
   */
  costGetBudgetStatus: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.COST_GET_BUDGET_STATUS);
  },

  /**
   * Listen for cost usage events
   */
  onCostUsageRecorded: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('cost:usage-recorded', handler);
    return () => ipcRenderer.removeListener('cost:usage-recorded', handler);
  },

  /**
   * Listen for budget warning events
   */
  onCostBudgetWarning: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('cost:budget-warning', handler);
    return () => ipcRenderer.removeListener('cost:budget-warning', handler);
  },

  /**
   * Listen for budget exceeded events
   */
  onCostBudgetExceeded: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('cost:budget-exceeded', handler);
    return () => ipcRenderer.removeListener('cost:budget-exceeded', handler);
  },

  // ============================================
  // Session Archive (1.3)
  // ============================================

  /**
   * Archive a session
   */
  archiveSession: (
    sessionId: string,
    sessionData: unknown,
    options?: { compress?: boolean; metadata?: Record<string, unknown> }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_SESSION, { sessionId, sessionData, options });
  },

  /**
   * List archives
   */
  archiveList: (filter?: {
    startDate?: number;
    endDate?: number;
    limit?: number;
    tags?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_LIST, { filter });
  },

  /**
   * Restore archive
   */
  archiveRestore: (archiveId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_RESTORE, { archiveId });
  },

  /**
   * Delete archive
   */
  archiveDelete: (archiveId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_DELETE, { archiveId });
  },

  /**
   * Search archives
   */
  archiveSearch: (
    query: string,
    options?: { limit?: number; fields?: string[] }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_SEARCH, { query, options });
  },

  // ============================================
  // Remote Config (6.2)
  // ============================================

  /**
   * Fetch remote config
   */
  remoteConfigFetch: (force?: boolean): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOTE_CONFIG_FETCH, { force });
  },

  /**
   * Get config value
   */
  remoteConfigGet: (key: string, defaultValue?: unknown): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOTE_CONFIG_GET, { key, defaultValue });
  },

  /**
   * Set config source
   */
  remoteConfigSetSource: (source: {
    type: 'url' | 'file' | 'git';
    location: string;
    refreshInterval?: number;
    branch?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOTE_CONFIG_SET_SOURCE, { source });
  },

  /**
   * Get config status
   */
  remoteConfigStatus: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOTE_CONFIG_STATUS);
  },

  /**
   * Listen for remote config updates
   */
  onRemoteConfigUpdated: (callback: (config: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, config: unknown) => callback(config);
    ipcRenderer.on('remote-config:updated', handler);
    return () => ipcRenderer.removeListener('remote-config:updated', handler);
  },

  /**
   * Listen for remote config errors
   */
  onRemoteConfigError: (callback: (error: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, error: unknown) => callback(error);
    ipcRenderer.on('remote-config:error', handler);
    return () => ipcRenderer.removeListener('remote-config:error', handler);
  },

  // ============================================
  // External Editor (9.2)
  // ============================================

  /**
   * Open file in external editor
   */
  editorOpen: (
    filePath: string,
    options?: { editor?: string; line?: number; column?: number; waitForClose?: boolean }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.EDITOR_OPEN, { filePath, options });
  },

  /**
   * Get available editors
   */
  editorGetAvailable: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.EDITOR_GET_AVAILABLE);
  },

  /**
   * Set default editor
   */
  editorSetDefault: (editorId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.EDITOR_SET_DEFAULT, { editorId });
  },

  /**
   * Get default editor
   */
  editorGetDefault: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.EDITOR_GET_DEFAULT);
  },

  // ============================================
  // File Watcher (10.1)
  // ============================================

  /**
   * Watch a path for changes
   */
  watcherWatch: (
    path: string,
    options?: { recursive?: boolean; patterns?: string[]; ignorePatterns?: string[]; debounceMs?: number }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WATCHER_WATCH, { path, options });
  },

  /**
   * Stop watching a path
   */
  watcherUnwatch: (watcherId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WATCHER_UNWATCH, { watcherId });
  },

  /**
   * Get active watchers
   */
  watcherGetActive: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WATCHER_GET_ACTIVE);
  },

  /**
   * Listen for file change events
   */
  onWatcherFileChanged: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('watcher:file-changed', handler);
    return () => ipcRenderer.removeListener('watcher:file-changed', handler);
  },

  /**
   * Listen for file added events
   */
  onWatcherFileAdded: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('watcher:file-added', handler);
    return () => ipcRenderer.removeListener('watcher:file-added', handler);
  },

  /**
   * Listen for file removed events
   */
  onWatcherFileRemoved: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('watcher:file-removed', handler);
    return () => ipcRenderer.removeListener('watcher:file-removed', handler);
  },

  /**
   * Listen for watcher errors
   */
  onWatcherError: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('watcher:error', handler);
    return () => ipcRenderer.removeListener('watcher:error', handler);
  },

  // ============================================
  // Logging (13.1)
  // ============================================

  /**
   * Log a message
   */
  logMessage: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context?: string,
    metadata?: Record<string, unknown>
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOG_MESSAGE, { level, message, context, metadata });
  },

  /**
   * Get logs
   */
  logGetLogs: (options?: {
    level?: 'debug' | 'info' | 'warn' | 'error';
    context?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOG_GET_LOGS, { options });
  },

  /**
   * Set log level
   */
  logSetLevel: (level: 'debug' | 'info' | 'warn' | 'error'): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOG_SET_LEVEL, { level });
  },

  /**
   * Export logs
   */
  logExport: (
    filePath: string,
    options?: { format?: 'json' | 'csv'; compress?: boolean }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOG_EXPORT, { filePath, options });
  },

  /**
   * Clear logs
   */
  logClear: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LOG_CLEAR);
  },

  // ============================================
  // Debug Commands (13.2)
  // ============================================

  /**
   * Execute debug command
   */
  debugExecute: (command: string, args?: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBUG_EXECUTE, { command, args });
  },

  /**
   * Get available debug commands
   */
  debugGetCommands: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBUG_GET_COMMANDS);
  },

  /**
   * Get debug info
   */
  debugGetInfo: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBUG_GET_INFO);
  },

  /**
   * Run diagnostics
   */
  debugRunDiagnostics: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBUG_RUN_DIAGNOSTICS);
  },

  // ============================================
  // Usage Stats (14.1)
  // ============================================

  /**
   * Record session start
   */
  statsRecordSessionStart: (
    sessionId: string,
    instanceId: string,
    agentId: string,
    workingDirectory: string
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_RECORD_SESSION_START, {
      sessionId,
      instanceId,
      agentId,
      workingDirectory,
    });
  },

  /**
   * Record session end
   */
  statsRecordSessionEnd: (sessionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_RECORD_SESSION_END, { sessionId });
  },

  /**
   * Record message stats
   */
  statsRecordMessage: (
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_RECORD_MESSAGE, {
      sessionId,
      inputTokens,
      outputTokens,
      cost,
    });
  },

  /**
   * Record tool usage
   */
  statsRecordToolUsage: (sessionId: string, tool: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_RECORD_TOOL_USAGE, { sessionId, tool });
  },

  /**
   * Get stats for a period
   */
  statsGetStats: (period: 'day' | 'week' | 'month' | 'year' | 'all'): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_GET_STATS, { period });
  },

  /**
   * Export stats
   */
  statsExport: (
    filePath: string,
    period?: 'day' | 'week' | 'month' | 'year' | 'all'
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.STATS_EXPORT, { filePath, period });
  },

  // ============================================
  // Semantic Search (4.7)
  // ============================================

  /**
   * Perform semantic search
   */
  searchSemantic: (options: {
    query: string;
    directory: string;
    maxResults?: number;
    includePatterns?: string[];
    excludePatterns?: string[];
    searchType?: 'semantic' | 'hybrid' | 'keyword';
    minScore?: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SEMANTIC, { options });
  },

  /**
   * Build search index
   */
  searchBuildIndex: (
    directory: string,
    includePatterns?: string[],
    excludePatterns?: string[]
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_BUILD_INDEX, {
      directory,
      includePatterns,
      excludePatterns,
    });
  },

  /**
   * Configure Exa API for enhanced search
   */
  searchConfigureExa: (config: {
    apiKey: string;
    baseUrl?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_CONFIGURE_EXA, { config });
  },

  /**
   * Get search index stats
   */
  searchGetIndexStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_INDEX_STATS);
  },

  // ============================================
  // Provider Plugins (12.2)
  // ============================================

  /**
   * Discover available plugins
   */
  pluginsDiscover: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_DISCOVER);
  },

  /**
   * Load a plugin
   */
  pluginsLoad: (
    pluginId: string,
    options?: { timeout?: number; sandbox?: boolean }
  ): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_LOAD, { pluginId, options });
  },

  /**
   * Unload a plugin
   */
  pluginsUnload: (pluginId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_UNLOAD, { pluginId });
  },

  /**
   * Install a plugin from file
   */
  pluginsInstall: (sourcePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_INSTALL, { sourcePath });
  },

  /**
   * Uninstall a plugin
   */
  pluginsUninstall: (pluginId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_UNINSTALL, { pluginId });
  },

  /**
   * Get loaded plugins
   */
  pluginsGetLoaded: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_GET_LOADED);
  },

  /**
   * Create a plugin template
   */
  pluginsCreateTemplate: (name: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_CREATE_TEMPLATE, { name });
  },

  /**
   * Listen for plugin loaded events
   */
  onPluginLoaded: (callback: (data: { pluginId: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { pluginId: string }) => callback(data);
    ipcRenderer.on('plugins:loaded', handler);
    return () => ipcRenderer.removeListener('plugins:loaded', handler);
  },

  /**
   * Listen for plugin unloaded events
   */
  onPluginUnloaded: (callback: (data: { pluginId: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { pluginId: string }) => callback(data);
    ipcRenderer.on('plugins:unloaded', handler);
    return () => ipcRenderer.removeListener('plugins:unloaded', handler);
  },

  /**
   * Listen for plugin error events
   */
  onPluginError: (callback: (data: { pluginId: string; error: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { pluginId: string; error: string }) => callback(data);
    ipcRenderer.on('plugins:error', handler);
    return () => ipcRenderer.removeListener('plugins:error', handler);
  },

  // ============================================
  // Phase 6: Workflows (6.1)
  // ============================================

  /**
   * List available workflow templates
   */
  workflowListTemplates: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_LIST_TEMPLATES);
  },

  /**
   * Get a specific workflow template
   */
  workflowGetTemplate: (templateId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_TEMPLATE, { templateId });
  },

  /**
   * Start a workflow
   */
  workflowStart: (payload: {
    instanceId: string;
    templateId: string;
    config?: Record<string, unknown>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_START, payload);
  },

  /**
   * Get workflow execution status
   */
  workflowGetExecution: (executionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_EXECUTION, { executionId });
  },

  /**
   * Get workflow execution for instance
   */
  workflowGetByInstance: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_BY_INSTANCE, { instanceId });
  },

  /**
   * Complete a workflow phase
   */
  workflowCompletePhase: (executionId: string, phaseId: string, result?: unknown): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_COMPLETE_PHASE, { executionId, phaseId, result });
  },

  /**
   * Satisfy a workflow gate
   */
  workflowSatisfyGate: (executionId: string, gateId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_SATISFY_GATE, { executionId, gateId });
  },

  /**
   * Skip a workflow phase
   */
  workflowSkipPhase: (executionId: string, phaseId: string, reason?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_SKIP_PHASE, { executionId, phaseId, reason });
  },

  /**
   * Cancel a workflow
   */
  workflowCancel: (executionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_CANCEL, { executionId });
  },

  /**
   * Get workflow prompt addition
   */
  workflowGetPromptAddition: (executionId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKFLOW_GET_PROMPT_ADDITION, { executionId });
  },

  // ============================================
  // Phase 6: Review Agents (6.2)
  // ============================================

  /**
   * List available review agents
   */
  reviewListAgents: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REVIEW_LIST_AGENTS);
  },

  /**
   * Get a specific review agent
   */
  reviewGetAgent: (agentId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GET_AGENT, { agentId });
  },

  // ============================================
  // Phase 6: Hooks (6.3)
  // ============================================

  /**
   * List hooks
   */
  hooksList: (filter?: { event?: string; scope?: string }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_LIST, { filter });
  },

  /**
   * Get a hook by ID
   */
  hooksGet: (hookId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET, { hookId });
  },

  /**
   * Create a new hook
   */
  hooksCreate: (payload: {
    name: string;
    event: string;
    command: string;
    conditions?: Record<string, unknown>;
    scope?: 'global' | 'project';
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_CREATE, payload);
  },

  /**
   * Update a hook
   */
  hooksUpdate: (hookId: string, updates: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_UPDATE, { hookId, updates });
  },

  /**
   * Delete a hook
   */
  hooksDelete: (hookId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_DELETE, { hookId });
  },

  /**
   * Evaluate hooks for an event
   */
  hooksEvaluate: (event: string, context: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_EVALUATE, { event, context });
  },

  /**
   * Import hooks from file
   */
  hooksImport: (filePath: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_IMPORT, { filePath });
  },

  /**
   * Export hooks to file
   */
  hooksExport: (filePath: string, hookIds?: string[]): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.HOOKS_EXPORT, { filePath, hookIds });
  },

  // ============================================
  // Phase 6: Skills (6.4)
  // ============================================

  /**
   * Discover skills in a directory
   */
  skillsDiscover: (directory?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DISCOVER, { directory });
  },

  /**
   * List available skills
   */
  skillsList: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST);
  },

  /**
   * Get a skill by ID
   */
  skillsGet: (skillId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET, { skillId });
  },

  /**
   * Load a skill
   */
  skillsLoad: (skillId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LOAD, { skillId });
  },

  /**
   * Unload a skill
   */
  skillsUnload: (skillId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_UNLOAD, { skillId });
  },

  /**
   * Load reference documentation for a skill
   */
  skillsLoadReference: (skillId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LOAD_REFERENCE, { skillId });
  },

  /**
   * Load example for a skill
   */
  skillsLoadExample: (skillId: string, exampleId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LOAD_EXAMPLE, { skillId, exampleId });
  },

  /**
   * Match skills to a query
   */
  skillsMatch: (query: string, maxResults?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_MATCH, { query, maxResults });
  },

  /**
   * Get skill memory
   */
  skillsGetMemory: (skillId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET_MEMORY, { skillId });
  },

  // ============================================
  // Phase 7: Worktrees (7.1)
  // ============================================

  /**
   * Create a worktree for isolated work
   */
  worktreeCreate: (payload: {
    instanceId: string;
    baseBranch?: string;
    branchName?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CREATE, payload);
  },

  /**
   * List worktrees
   */
  worktreeList: (instanceId?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_LIST, { instanceId });
  },

  /**
   * Delete a worktree
   */
  worktreeDelete: (worktreeId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_DELETE, { worktreeId });
  },

  /**
   * Get worktree status
   */
  worktreeGetStatus: (worktreeId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_STATUS, { worktreeId });
  },

  // ============================================
  // Phase 7: Specialists (7.4)
  // ============================================

  /**
   * List all specialist profiles
   */
  specialistList: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_LIST);
  },

  /**
   * List built-in specialist profiles
   */
  specialistListBuiltin: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_LIST_BUILTIN);
  },

  /**
   * List custom specialist profiles
   */
  specialistListCustom: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_LIST_CUSTOM);
  },

  /**
   * Get a specialist profile
   */
  specialistGet: (profileId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET, { profileId });
  },

  /**
   * Get specialist profiles by category
   */
  specialistGetByCategory: (category: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET_BY_CATEGORY, { category });
  },

  /**
   * Add a custom specialist profile
   */
  specialistAddCustom: (profile: {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    color: string;
    systemPromptAddition: string;
    restrictedTools: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_ADD_CUSTOM, { profile });
  },

  /**
   * Update a custom specialist profile
   */
  specialistUpdateCustom: (profileId: string, updates: {
    name?: string;
    description?: string;
    category?: string;
    icon?: string;
    color?: string;
    systemPromptAddition?: string;
    restrictedTools?: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE_CUSTOM, { profileId, updates });
  },

  /**
   * Remove a custom specialist profile
   */
  specialistRemoveCustom: (profileId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_REMOVE_CUSTOM, { profileId });
  },

  /**
   * Get specialist recommendations based on context
   */
  specialistRecommend: (context: {
    taskDescription?: string;
    fileTypes?: string[];
    userPreferences?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_RECOMMEND, { context });
  },

  /**
   * Create a specialist instance
   */
  specialistCreateInstance: (profileId: string, orchestratorInstanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_CREATE_INSTANCE, { profileId, orchestratorInstanceId });
  },

  /**
   * Get a specialist instance
   */
  specialistGetInstance: (instanceId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET_INSTANCE, { instanceId });
  },

  /**
   * Get all active specialist instances
   */
  specialistGetActiveInstances: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET_ACTIVE_INSTANCES);
  },

  /**
   * Update specialist instance status
   */
  specialistUpdateStatus: (instanceId: string, status: 'active' | 'paused' | 'completed' | 'failed'): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE_STATUS, { instanceId, status });
  },

  /**
   * Add a finding to a specialist instance
   */
  specialistAddFinding: (instanceId: string, finding: {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    filePath?: string;
    lineRange?: { start: number; end: number };
    codeSnippet?: string;
    suggestion?: string;
    confidence: number;
    tags?: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_ADD_FINDING, { instanceId, finding });
  },

  /**
   * Update specialist instance metrics
   */
  specialistUpdateMetrics: (instanceId: string, updates: {
    filesAnalyzed?: number;
    linesAnalyzed?: number;
    findingsCount?: number;
    tokensUsed?: number;
    durationMs?: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_UPDATE_METRICS, { instanceId, updates });
  },

  /**
   * Get system prompt addition for a specialist
   */
  specialistGetPromptAddition: (profileId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SPECIALIST_GET_PROMPT_ADDITION, { profileId });
  },

  // ============================================
  // Phase 7: Supervision (7.3)
  // ============================================

  /**
   * Get supervision tree
   */
  supervisionGetTree: (rootInstanceId?: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SUPERVISION_GET_TREE, { rootInstanceId });
  },

  /**
   * Get supervision health status
   */
  supervisionGetHealth: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SUPERVISION_GET_HEALTH);
  },

  // ============================================
  // Phase 8: RLM Context (8.1)
  // ============================================

  /**
   * Record task outcome for RLM
   */
  rlmRecordOutcome: (payload: {
    taskId: string;
    success: boolean;
    score: number;
    context: Record<string, unknown>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RLM_RECORD_OUTCOME, payload);
  },

  /**
   * Get RLM learned patterns
   */
  rlmGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RLM_GET_PATTERNS, { minSuccessRate });
  },

  /**
   * Get RLM strategy suggestions
   */
  rlmGetStrategySuggestions: (context: string, maxSuggestions?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RLM_GET_STRATEGY_SUGGESTIONS, { context, maxSuggestions });
  },

  // ============================================
  // Phase 8: Learning (8.2)
  // ============================================

  /**
   * Record learning outcome
   */
  learningRecordOutcome: (payload: {
    taskId: string;
    strategy: string;
    success: boolean;
    score: number;
    context?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LEARNING_RECORD_OUTCOME, payload);
  },

  /**
   * Get learning patterns
   */
  learningGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LEARNING_GET_PATTERNS, { minSuccessRate });
  },

  /**
   * Get learning suggestions
   */
  learningGetSuggestions: (context: string, maxSuggestions?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LEARNING_GET_SUGGESTIONS, { context, maxSuggestions });
  },

  /**
   * Enhance prompt with learning
   */
  learningEnhancePrompt: (prompt: string, context: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.LEARNING_ENHANCE_PROMPT, { prompt, context });
  },

  // ============================================
  // Phase 8: Verification (8.3)
  // ============================================

  /**
   * Verify with multiple models (API-based)
   */
  verificationVerifyMulti: (payload: {
    query: string;
    context?: string;
    models?: string[];
    consensusThreshold?: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VERIFICATION_VERIFY_MULTI, payload);
  },

  /**
   * Start CLI-based verification
   */
  verificationStartCli: (payload: {
    id: string;
    prompt: string;
    context?: string;
    config: {
      cliAgents?: string[];
      agentCount?: number;
      synthesisStrategy?: string;
      personalities?: string[];
      confidenceThreshold?: number;
      timeout?: number;
      maxDebateRounds?: number;
      fallbackToApi?: boolean;
      mixedMode?: boolean;
    };
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VERIFICATION_START_CLI, payload);
  },

  /**
   * Cancel an ongoing verification
   */
  verificationCancel: (payload: { id: string }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VERIFICATION_CANCEL, payload);
  },

  /**
   * Get active verifications
   */
  verificationGetActive: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VERIFICATION_GET_ACTIVE);
  },

  /**
   * Get verification result
   */
  verificationGetResult: (verificationId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.VERIFICATION_GET_RESULT, { verificationId });
  },

  // ============================================
  // Phase 9: Memory-R1 (9.1)
  // ============================================

  /**
   * Memory-R1: Decide what operation to perform
   */
  memoryR1DecideOperation: (payload: {
    context: string;
    candidateContent: string;
    taskId: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_DECIDE_OPERATION, payload);
  },

  /**
   * Memory-R1: Execute a decided operation
   */
  memoryR1ExecuteOperation: (decision: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_EXECUTE_OPERATION, decision);
  },

  /**
   * Memory-R1: Add entry directly
   */
  memoryR1AddEntry: (payload: {
    content: string;
    reason: string;
    sourceType?: string;
    sourceSessionId?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_ADD_ENTRY, payload);
  },

  /**
   * Memory-R1: Delete entry
   */
  memoryR1DeleteEntry: (entryId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_DELETE_ENTRY, entryId);
  },

  /**
   * Memory-R1: Get entry
   */
  memoryR1GetEntry: (entryId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_GET_ENTRY, entryId);
  },

  /**
   * Memory-R1: Retrieve memories
   */
  memoryR1Retrieve: (payload: { query: string; taskId: string }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_RETRIEVE, payload);
  },

  /**
   * Memory-R1: Record task outcome
   */
  memoryR1RecordOutcome: (payload: {
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_RECORD_OUTCOME, payload);
  },

  /**
   * Memory-R1: Get stats
   */
  memoryR1GetStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_GET_STATS);
  },

  /**
   * Memory-R1: Save state
   */
  memoryR1Save: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_SAVE);
  },

  /**
   * Memory-R1: Load state
   */
  memoryR1Load: (snapshot: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_LOAD, snapshot);
  },

  /**
   * Memory-R1: Configure
   */
  memoryR1Configure: (config: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MEMORY_R1_CONFIGURE, config);
  },

  // ============================================
  // Phase 9: Unified Memory (9.2)
  // ============================================

  /**
   * Unified Memory: Process input
   */
  unifiedMemoryProcessInput: (payload: {
    input: string;
    sessionId: string;
    taskId: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_PROCESS_INPUT, payload);
  },

  /**
   * Unified Memory: Retrieve
   */
  unifiedMemoryRetrieve: (payload: {
    query: string;
    taskId: string;
    options?: { types?: string[]; maxTokens?: number };
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_RETRIEVE, payload);
  },

  /**
   * Unified Memory: Record session end
   */
  unifiedMemoryRecordSessionEnd: (payload: {
    sessionId: string;
    outcome: string;
    summary: string;
    lessons: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_RECORD_SESSION_END, payload);
  },

  /**
   * Unified Memory: Record workflow
   */
  unifiedMemoryRecordWorkflow: (payload: {
    name: string;
    steps: string[];
    applicableContexts: string[];
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_RECORD_WORKFLOW, payload);
  },

  /**
   * Unified Memory: Record strategy
   */
  unifiedMemoryRecordStrategy: (payload: {
    strategy: string;
    conditions: string[];
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_RECORD_STRATEGY, payload);
  },

  /**
   * Unified Memory: Record outcome
   */
  unifiedMemoryRecordOutcome: (payload: {
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_RECORD_OUTCOME, payload);
  },

  /**
   * Unified Memory: Get stats
   */
  unifiedMemoryGetStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_GET_STATS);
  },

  /**
   * Unified Memory: Get sessions
   */
  unifiedMemoryGetSessions: (limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS, limit);
  },

  /**
   * Unified Memory: Get patterns
   */
  unifiedMemoryGetPatterns: (minSuccessRate?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS, minSuccessRate);
  },

  /**
   * Unified Memory: Get workflows
   */
  unifiedMemoryGetWorkflows: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS);
  },

  /**
   * Unified Memory: Save state
   */
  unifiedMemorySave: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_SAVE);
  },

  /**
   * Unified Memory: Load state
   */
  unifiedMemoryLoad: (snapshot: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_LOAD, snapshot);
  },

  /**
   * Unified Memory: Configure
   */
  unifiedMemoryConfigure: (config: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_MEMORY_CONFIGURE, config);
  },

  // ============================================
  // Phase 9: Debate (9.3)
  // ============================================

  /**
   * Start a debate
   */
  debateStart: (payload: {
    query: string;
    context?: string;
    config?: Record<string, unknown>;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBATE_START, payload);
  },

  /**
   * Get debate result
   */
  debateGetResult: (debateId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBATE_GET_RESULT, debateId);
  },

  /**
   * Get active debates
   */
  debateGetActive: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBATE_GET_ACTIVE);
  },

  /**
   * Cancel debate
   */
  debateCancel: (debateId: string): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBATE_CANCEL, debateId);
  },

  /**
   * Get debate stats
   */
  debateGetStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DEBATE_GET_STATS);
  },

  // ============================================
  // Phase 9: Training/GRPO (9.4)
  // ============================================

  /**
   * Record training outcome
   */
  trainingRecordOutcome: (payload: {
    taskId: string;
    prompt: string;
    response: string;
    reward: number;
    strategy?: string;
    context?: string;
  }): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_RECORD_OUTCOME, payload);
  },

  /**
   * Get training stats
   */
  trainingGetStats: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_GET_STATS);
  },

  /**
   * Export training data
   */
  trainingExportData: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_EXPORT_DATA);
  },

  /**
   * Import training data
   */
  trainingImportData: (data: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_IMPORT_DATA, data);
  },

  /**
   * Get reward trend
   */
  trainingGetTrend: (): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_GET_TREND);
  },

  /**
   * Get top strategies
   */
  trainingGetTopStrategies: (limit?: number): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_GET_TOP_STRATEGIES, limit);
  },

  /**
   * Configure training
   */
  trainingConfigure: (config: Record<string, unknown>): Promise<IpcResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRAINING_CONFIGURE, config);
  },

  // ============================================
  // Generic IPC Methods (for dynamic channels)
  // ============================================

  /**
   * Generic invoke - call any IPC channel
   * Use when specific method is not available
   */
  invoke: (channel: string, payload?: unknown): Promise<IpcResponse> => {
    return ipcRenderer.invoke(channel, payload);
  },

  /**
   * Generic event listener - subscribe to any IPC channel
   * Use when specific onXxx method is not available
   * Returns an unsubscribe function
   */
  on: (channel: string, callback: (data: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  /**
   * One-time event listener - fires once then auto-removes
   */
  once: (channel: string, callback: (data: unknown) => void): void => {
    ipcRenderer.once(channel, (_event: IpcRendererEvent, data: unknown) => callback(data));
  },

  // ============================================
  // Platform Info
  // ============================================

  /**
   * Get current platform
   */
  platform: process.platform,
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Type declaration for TypeScript
export type ElectronAPI = typeof electronAPI;
