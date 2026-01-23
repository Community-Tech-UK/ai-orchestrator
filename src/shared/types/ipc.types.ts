/**
 * IPC Types - Inter-Process Communication between Main and Renderer
 */

import type {
  ContextUsage,
  FileAttachment,
  InstanceStatus,
  OutputMessage,
  InstanceProvider
} from './instance.types';

/**
 * IPC Channel names - domain:action pattern
 */
export const IPC_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_CREATE_WITH_MESSAGE: 'instance:create-with-message',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_OUTPUT: 'instance:output',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',

  // Cross-instance communication
  COMM_REQUEST_TOKEN: 'comm:request-token',
  COMM_SEND_MESSAGE: 'comm:send-message',
  COMM_SUBSCRIBE: 'comm:subscribe',
  COMM_CONTROL: 'comm:control-instance',
  COMM_CREATE_BRIDGE: 'comm:create-bridge',

  // Supervisor operations
  SUPERVISOR_STATUS: 'supervisor:status',
  SUPERVISOR_METRICS: 'supervisor:metrics',

  // File operations
  FILE_DROP: 'file:drop',
  IMAGE_PASTE: 'image:paste',
  FILE_READ_DIR: 'file:read-dir',
  FILE_GET_STATS: 'file:get-stats',

  // App operations
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_CHECK: 'cli:check',

  // Copilot operations
  COPILOT_LIST_MODELS: 'copilot:list-models',

  // Dialog operations
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILES: 'dialog:select-files',

  // Settings operations
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

  // User action requests (orchestrator -> user)
  USER_ACTION_REQUEST: 'user-action:request',
  USER_ACTION_RESPOND: 'user-action:respond',
  USER_ACTION_LIST: 'user-action:list',
  USER_ACTION_LIST_FOR_INSTANCE: 'user-action:list-for-instance',

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

  // Task management (subagent spawning)
  TASK_GET_STATUS: 'task:get-status',
  TASK_GET_HISTORY: 'task:get-history',
  TASK_GET_BY_PARENT: 'task:get-by-parent',
  TASK_GET_BY_CHILD: 'task:get-by-child',
  TASK_CANCEL: 'task:cancel',
  TASK_GET_QUEUE: 'task:get-queue',
  TASK_COMPLETE: 'task:complete',
  TASK_PROGRESS: 'task:progress',
  TASK_ERROR: 'task:error',

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
  SECURITY_UPDATE_ENV_FILTER_CONFIG: 'security:update-env-filter-config',

  // Cost Tracking (5.3)
  COST_RECORD_USAGE: 'cost:record-usage',
  COST_GET_SUMMARY: 'cost:get-summary',
  COST_GET_SESSION_COST: 'cost:get-session-cost',
  COST_GET_BUDGET: 'cost:get-budget',
  COST_SET_BUDGET: 'cost:set-budget',
  COST_GET_BUDGET_STATUS: 'cost:get-budget-status',
  COST_GET_ENTRIES: 'cost:get-entries',
  COST_CLEAR_ENTRIES: 'cost:clear-entries',
  COST_BUDGET_ALERT: 'cost:budget-alert',

  // Session Archiving (1.3)
  ARCHIVE_SESSION: 'archive:session',
  ARCHIVE_RESTORE: 'archive:restore',
  ARCHIVE_DELETE: 'archive:delete',
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_GET_META: 'archive:get-meta',
  ARCHIVE_UPDATE_TAGS: 'archive:update-tags',
  ARCHIVE_GET_STATS: 'archive:get-stats',
  ARCHIVE_CLEANUP: 'archive:cleanup',

  // Remote Configuration (6.2)
  REMOTE_CONFIG_FETCH_URL: 'remote-config:fetch-url',
  REMOTE_CONFIG_FETCH_WELL_KNOWN: 'remote-config:fetch-well-known',
  REMOTE_CONFIG_FETCH_GITHUB: 'remote-config:fetch-github',
  REMOTE_CONFIG_DISCOVER_GIT: 'remote-config:discover-git',
  REMOTE_CONFIG_GET_CACHED: 'remote-config:get-cached',
  REMOTE_CONFIG_CLEAR_CACHE: 'remote-config:clear-cache',
  REMOTE_CONFIG_INVALIDATE: 'remote-config:invalidate',

  // External Editor (9.2)
  EDITOR_DETECT: 'editor:detect',
  EDITOR_OPEN_FILE: 'editor:open-file',
  EDITOR_OPEN_FILE_AT_LINE: 'editor:open-file-at-line',
  EDITOR_OPEN_DIRECTORY: 'editor:open-directory',
  EDITOR_SET_PREFERRED: 'editor:set-preferred',
  EDITOR_GET_PREFERRED: 'editor:get-preferred',
  EDITOR_GET_AVAILABLE: 'editor:get-available',

  // File Watcher (10.1)
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_STOP_ALL: 'watcher:stop-all',
  WATCHER_GET_SESSIONS: 'watcher:get-sessions',
  WATCHER_GET_CHANGES: 'watcher:get-changes',
  WATCHER_CLEAR_BUFFER: 'watcher:clear-buffer',
  WATCHER_FILE_CHANGED: 'watcher:file-changed',

  // Structured Logging (13.1)
  LOG_GET_RECENT: 'log:get-recent',
  LOG_GET_CONFIG: 'log:get-config',
  LOG_SET_LEVEL: 'log:set-level',
  LOG_SET_SUBSYSTEM_LEVEL: 'log:set-subsystem-level',
  LOG_CLEAR_BUFFER: 'log:clear-buffer',
  LOG_EXPORT: 'log:export',
  LOG_GET_SUBSYSTEMS: 'log:get-subsystems',
  LOG_GET_FILES: 'log:get-files',

  // Debug Commands (13.2)
  DEBUG_AGENT: 'debug:agent',
  DEBUG_CONFIG: 'debug:config',
  DEBUG_FILE: 'debug:file',
  DEBUG_MEMORY: 'debug:memory',
  DEBUG_SYSTEM: 'debug:system',
  DEBUG_PROCESS: 'debug:process',
  DEBUG_ALL: 'debug:all',
  DEBUG_GET_MEMORY_HISTORY: 'debug:get-memory-history',
  DEBUG_CLEAR_MEMORY_HISTORY: 'debug:clear-memory-history',

  // Usage Statistics (14.1)
  STATS_GET: 'stats:get',
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

  // Semantic Search (4.7)
  SEARCH_SEMANTIC: 'search:semantic',
  SEARCH_BUILD_INDEX: 'search:build-index',
  SEARCH_CLEAR_INDEX: 'search:clear-index',
  SEARCH_GET_INDEX_STATS: 'search:get-index-stats',
  SEARCH_CONFIGURE_EXA: 'search:configure-exa',
  SEARCH_IS_EXA_CONFIGURED: 'search:is-exa-configured',

  // Provider Plugins (12.2)
  PLUGINS_DISCOVER: 'plugins:discover',
  PLUGINS_LOAD: 'plugins:load',
  PLUGINS_UNLOAD: 'plugins:unload',
  PLUGINS_GET: 'plugins:get',
  PLUGINS_GET_ALL: 'plugins:get-all',
  PLUGINS_GET_META: 'plugins:get-meta',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_CREATE_TEMPLATE: 'plugins:create-template',

  // Workflow operations (6.1)
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
  WORKFLOW_STARTED: 'workflow:started',
  WORKFLOW_COMPLETED: 'workflow:completed',
  WORKFLOW_PHASE_CHANGED: 'workflow:phase-changed',
  WORKFLOW_GATE_PENDING: 'workflow:gate-pending',

  // Review agent operations (6.2)
  REVIEW_LIST_AGENTS: 'review:list-agents',
  REVIEW_GET_AGENT: 'review:get-agent',
  REVIEW_START_SESSION: 'review:start-session',
  REVIEW_GET_SESSION: 'review:get-session',
  REVIEW_GET_ISSUES: 'review:get-issues',
  REVIEW_ACKNOWLEDGE_ISSUE: 'review:acknowledge-issue',
  REVIEW_SESSION_STARTED: 'review:session-started',
  REVIEW_SESSION_COMPLETED: 'review:session-completed',

  // Hook operations (6.3)
  HOOKS_LIST: 'hooks:list',
  HOOKS_GET: 'hooks:get',
  HOOKS_CREATE: 'hooks:create',
  HOOKS_UPDATE: 'hooks:update',
  HOOKS_DELETE: 'hooks:delete',
  HOOKS_EVALUATE: 'hooks:evaluate',
  HOOKS_IMPORT: 'hooks:import',
  HOOKS_EXPORT: 'hooks:export',
  HOOK_APPROVALS_LIST: 'hooks:approvals:list',
  HOOK_APPROVALS_UPDATE: 'hooks:approvals:update',
  HOOK_APPROVALS_CLEAR: 'hooks:approvals:clear',
  HOOKS_TRIGGERED: 'hooks:triggered',

  // Skill operations (6.4)
  SKILLS_DISCOVER: 'skills:discover',
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_LOAD: 'skills:load',
  SKILLS_UNLOAD: 'skills:unload',
  SKILLS_LOAD_REFERENCE: 'skills:load-reference',
  SKILLS_LOAD_EXAMPLE: 'skills:load-example',
  SKILLS_MATCH: 'skills:match',
  SKILLS_GET_MEMORY: 'skills:get-memory',

  // Git Worktree operations (7.1)
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_COMPLETE: 'worktree:complete',
  WORKTREE_PREVIEW_MERGE: 'worktree:preview-merge',
  WORKTREE_MERGE: 'worktree:merge',
  WORKTREE_CLEANUP: 'worktree:cleanup',
  WORKTREE_ABANDON: 'worktree:abandon',
  WORKTREE_GET_SESSION: 'worktree:get-session',
  WORKTREE_LIST_SESSIONS: 'worktree:list-sessions',
  WORKTREE_DETECT_CONFLICTS: 'worktree:detect-conflicts',
  WORKTREE_SYNC: 'worktree:sync',
  WORKTREE_SESSION_CREATED: 'worktree:session-created',
  WORKTREE_SESSION_COMPLETED: 'worktree:session-completed',
  WORKTREE_CONFLICT_DETECTED: 'worktree:conflict-detected',

  // Multi-Agent Verification operations (7.2)
  VERIFY_START: 'verify:start',
  VERIFY_GET_RESULT: 'verify:get-result',
  VERIFY_GET_ACTIVE: 'verify:get-active',
  VERIFY_CANCEL: 'verify:cancel',
  VERIFY_GET_PERSONALITIES: 'verify:get-personalities',
  VERIFY_CONFIGURE: 'verify:configure',
  VERIFY_STARTED: 'verify:started',
  VERIFY_AGENT_RESPONDED: 'verify:agent-responded',
  VERIFY_COMPLETED: 'verify:completed',

  // Cascade Supervision operations (7.3)
  SUPERVISION_CREATE_TREE: 'supervision:create-tree',
  SUPERVISION_ADD_WORKER: 'supervision:add-worker',
  SUPERVISION_START_WORKER: 'supervision:start-worker',
  SUPERVISION_STOP_WORKER: 'supervision:stop-worker',
  SUPERVISION_HANDLE_FAILURE: 'supervision:handle-failure',
  SUPERVISION_GET_TREE: 'supervision:get-tree',
  SUPERVISION_GET_HEALTH: 'supervision:get-health',
  SUPERVISION_TREE_UPDATED: 'supervision:tree-updated',
  SUPERVISION_WORKER_FAILED: 'supervision:worker-failed',
  SUPERVISION_WORKER_RESTARTED: 'supervision:worker-restarted',
  SUPERVISION_CIRCUIT_BREAKER_CHANGED: 'supervision:circuit-breaker-changed',

  // RLM Context Management operations (8.1)
  RLM_CREATE_STORE: 'rlm:create-store',
  RLM_ADD_SECTION: 'rlm:add-section',
  RLM_REMOVE_SECTION: 'rlm:remove-section',
  RLM_GET_STORE: 'rlm:get-store',
  RLM_LIST_STORES: 'rlm:list-stores',
  RLM_LIST_SECTIONS: 'rlm:list-sections',
  RLM_LIST_SESSIONS: 'rlm:list-sessions',
  RLM_DELETE_STORE: 'rlm:delete-store',
  RLM_START_SESSION: 'rlm:start-session',
  RLM_END_SESSION: 'rlm:end-session',
  RLM_EXECUTE_QUERY: 'rlm:execute-query',
  RLM_GET_SESSION: 'rlm:get-session',
  RLM_GET_STORE_STATS: 'rlm:get-store-stats',
  RLM_GET_SESSION_STATS: 'rlm:get-session-stats',
  RLM_CONFIGURE: 'rlm:configure',
  RLM_RECORD_OUTCOME: 'rlm:record-outcome',
  RLM_GET_PATTERNS: 'rlm:get-patterns',
  RLM_GET_STRATEGY_SUGGESTIONS: 'rlm:get-strategy-suggestions',

  // Self-Improvement operations (8.2)
  LEARNING_RECORD_OUTCOME: 'learning:record-outcome',
  LEARNING_GET_OUTCOME: 'learning:get-outcome',
  LEARNING_GET_RECENT_OUTCOMES: 'learning:get-recent-outcomes',
  LEARNING_GET_EXPERIENCE: 'learning:get-experience',
  LEARNING_GET_ALL_EXPERIENCES: 'learning:get-all-experiences',
  LEARNING_GET_INSIGHTS: 'learning:get-insights',
  LEARNING_GET_RECOMMENDATION: 'learning:get-recommendation',
  LEARNING_ENHANCE_PROMPT: 'learning:enhance-prompt',
  LEARNING_GET_STATS: 'learning:get-stats',
  LEARNING_GET_TASK_STATS: 'learning:get-task-stats',
  LEARNING_RATE_OUTCOME: 'learning:rate-outcome',
  LEARNING_CONFIGURE: 'learning:configure',

  // Model Discovery operations (8.3)
  MODEL_DISCOVER: 'model:discover',
  MODEL_GET_ALL: 'model:get-all',
  MODEL_GET: 'model:get',
  MODEL_SELECT: 'model:select',
  MODEL_CONFIGURE_PROVIDER: 'model:configure-provider',
  MODEL_GET_PROVIDER_STATUS: 'model:get-provider-status',
  MODEL_GET_STATS: 'model:get-stats',
  MODEL_VERIFY: 'model:verify',
  MODEL_SET_OVERRIDE: 'model:set-override',
  MODEL_REMOVE_OVERRIDE: 'model:remove-override',

  // Memory-R1 operations
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

  // Unified Memory operations
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

  // Debate operations
  DEBATE_START: 'debate:start',
  DEBATE_GET_RESULT: 'debate:get-result',
  DEBATE_GET_ACTIVE: 'debate:get-active',
  DEBATE_CANCEL: 'debate:cancel',
  DEBATE_GET_STATS: 'debate:get-stats',

  // Training operations (GRPO)
  TRAINING_RECORD_OUTCOME: 'training:record-outcome',
  TRAINING_GET_STATS: 'training:get-stats',
  TRAINING_EXPORT_DATA: 'training:export-data',
  TRAINING_IMPORT_DATA: 'training:import-data',
  TRAINING_GET_TREND: 'training:get-trend',
  TRAINING_GET_TOP_STRATEGIES: 'training:get-top-strategies',
  TRAINING_CONFIGURE: 'training:configure',

  // Specialist operations (7.4)
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
  SPECIALIST_INSTANCE_CREATED: 'specialist:instance-created',
  SPECIALIST_INSTANCE_STATUS_CHANGED: 'specialist:instance-status-changed',
  SPECIALIST_FINDING_ADDED: 'specialist:finding-added',

  // LLM Service operations (streaming)
  LLM_SUMMARIZE: 'llm:summarize',
  LLM_SUMMARIZE_STREAM: 'llm:summarize-stream',
  LLM_SUBQUERY: 'llm:subquery',
  LLM_SUBQUERY_STREAM: 'llm:subquery-stream',
  LLM_CANCEL_STREAM: 'llm:cancel-stream',
  LLM_STREAM_CHUNK: 'llm:stream-chunk',
  LLM_COUNT_TOKENS: 'llm:count-tokens',
  LLM_TRUNCATE_TOKENS: 'llm:truncate-tokens',
  LLM_GET_CONFIG: 'llm:get-config',
  LLM_SET_CONFIG: 'llm:set-config',
  LLM_GET_STATUS: 'llm:get-status',

  // A/B Testing operations (Phase 6)
  AB_CREATE_EXPERIMENT: 'ab:create-experiment',
  AB_UPDATE_EXPERIMENT: 'ab:update-experiment',
  AB_DELETE_EXPERIMENT: 'ab:delete-experiment',
  AB_START_EXPERIMENT: 'ab:start-experiment',
  AB_PAUSE_EXPERIMENT: 'ab:pause-experiment',
  AB_COMPLETE_EXPERIMENT: 'ab:complete-experiment',
  AB_GET_EXPERIMENT: 'ab:get-experiment',
  AB_LIST_EXPERIMENTS: 'ab:list-experiments',
  AB_GET_VARIANT: 'ab:get-variant',
  AB_RECORD_OUTCOME: 'ab:record-outcome',
  AB_GET_RESULTS: 'ab:get-results',
  AB_GET_WINNER: 'ab:get-winner',
  AB_GET_STATS: 'ab:get-stats',
  AB_CONFIGURE: 'ab:configure'
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Message envelope for all IPC communication
 */
export interface IpcMessage<T = unknown> {
  id: string;
  channel: IpcChannel;
  timestamp: number;
  payload: T;
  replyChannel?: string;
}

// ============================================
// Instance Management Payloads
// ============================================

export interface InstanceCreatePayload {
  workingDirectory: string;
  sessionId?: string;
  parentInstanceId?: string;
  displayName?: string;
  initialPrompt?: string;
  attachments?: FileAttachment[];
  yoloMode?: boolean;
  agentId?: string; // Agent profile ID (defaults to 'build')
  provider?: InstanceProvider; // CLI provider (defaults to 'auto')
  model?: string; // Model override (e.g., for Copilot multi-model support)
}

export interface InstanceStateUpdatePayload {
  instanceId: string;
  status: InstanceStatus;
  contextUsage?: ContextUsage;
  error?: ErrorInfo;
}

export interface InstanceOutputPayload {
  instanceId: string;
  message: OutputMessage;
}

export interface BatchUpdatePayload {
  updates: InstanceStateUpdatePayload[];
  timestamp: number;
}

export interface InstanceSendInputPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
}

export interface InstanceTerminatePayload {
  instanceId: string;
  graceful?: boolean;
}

export interface InstanceInterruptPayload {
  instanceId: string;
}

export interface InstanceRestartPayload {
  instanceId: string;
}

export interface InstanceRenamePayload {
  instanceId: string;
  displayName: string;
}

// ============================================
// Communication Payloads
// ============================================

export interface TokenRequestPayload {
  sourceInstanceId: string;
  targetInstanceId: string;
  permissions: ('read' | 'write' | 'control')[];
  ttlMs?: number;
}

export interface TokenResponsePayload {
  success: boolean;
  token?: string;
  error?: string;
}

export interface CrossInstanceMessagePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  message: string;
  asInput?: boolean;
}

export interface ControlInstancePayload {
  fromInstanceId: string;
  toInstanceId: string;
  token: string;
  command: 'restart' | 'terminate' | 'pause';
}

export interface SubscribePayload {
  subscriberId: string;
  targetId: string;
  token: string;
}

export interface CreateBridgePayload {
  sourceId: string;
  targetId: string;
  token: string;
}

// ============================================
// Supervisor Payloads
// ============================================

export interface SupervisorMetrics {
  totalNodes: number;
  totalInstances: number;
  nodeMetrics: SupervisorNodeMetrics[];
}

export interface SupervisorNodeMetrics {
  nodeId: string;
  name: string;
  childCount: number;
  maxChildren: number;
  load: number;
  childSupervisorCount: number;
}

// ============================================
// Error Types
// ============================================

export interface ErrorInfo {
  code: string;
  message: string;
  stack?: string;
  timestamp: number;
}

// ============================================
// Settings Payloads
// ============================================

export interface SettingsSetPayload {
  key: string;
  value: unknown;
}

export interface SettingsUpdatePayload {
  settings: Record<string, unknown>;
}

export interface SettingsResetOnePayload {
  key: string;
}

export interface SettingsChangedPayload {
  key: string;
  value: unknown;
}

// ============================================
// Memory Management Payloads
// ============================================

export interface MemoryStatsPayload {
  process: {
    heapUsedMB: number;
    heapTotalMB: number;
    externalMB: number;
    rssMB: number;
    percentUsed: number;
  };
  storage: {
    totalInstances: number;
    totalMessages: number;
    totalSizeMB: number;
    maxSizeMB: number;
  };
  pressureLevel: 'normal' | 'warning' | 'critical';
}

export interface MemoryWarningPayload {
  heapUsedMB: number;
  heapTotalMB: number;
  message: string;
}

export interface LoadHistoryPayload {
  instanceId: string;
  limit?: number;
}

// ============================================
// History Payloads
// ============================================

export interface HistoryListPayload {
  limit?: number;
  searchQuery?: string;
  workingDirectory?: string;
}

export interface HistoryLoadPayload {
  entryId: string;
}

export interface HistoryDeletePayload {
  entryId: string;
}

export interface HistoryRestorePayload {
  entryId: string;
  workingDirectory?: string;
}

// ============================================
// Response Types
// ============================================

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ErrorInfo;
}

// ============================================
// Provider Payloads
// ============================================

export interface ProviderStatusPayload {
  providerType: string;
  forceRefresh?: boolean;
}

export interface ProviderUpdateConfigPayload {
  providerType: string;
  config: Record<string, unknown>;
  ipcAuthToken?: string;
}

// ============================================
// Session Payloads
// ============================================

export interface SessionForkPayload {
  instanceId: string;
  atMessageIndex?: number; // Fork at specific message, defaults to latest
  displayName?: string;
}

export interface SessionExportPayload {
  instanceId: string;
  format: 'json' | 'markdown';
  includeMetadata?: boolean;
}

export interface SessionImportPayload {
  filePath: string;
  workingDirectory?: string;
}

export interface SessionCopyToClipboardPayload {
  instanceId: string;
  format: 'json' | 'markdown';
}

export interface SessionSaveToFilePayload {
  instanceId: string;
  format: 'json' | 'markdown';
  filePath?: string; // If not provided, will show save dialog
}

export interface SessionRevealFilePayload {
  filePath: string;
}

// ============================================
// Command Payloads
// ============================================

export interface CommandExecutePayload {
  commandId: string;
  instanceId: string;
  args?: string[];
}

export interface CommandCreatePayload {
  name: string;
  description: string;
  template: string;
  hint?: string;
}

export interface CommandUpdatePayload {
  commandId: string;
  updates: Partial<CommandCreatePayload>;
}

export interface CommandDeletePayload {
  commandId: string;
}

// ============================================
// Config Payloads (Hierarchical Configuration)
// ============================================

export interface ConfigResolvePayload {
  workingDirectory?: string;
}

export interface ConfigGetProjectPayload {
  configPath: string;
}

export interface ConfigSaveProjectPayload {
  configPath: string;
  config: Record<string, unknown>;
}

export interface ConfigCreateProjectPayload {
  projectDir: string;
  config?: Record<string, unknown>;
}

export interface ConfigFindProjectPayload {
  startDir: string;
}

// ============================================
// Plan Mode Payloads
// ============================================

export interface PlanModeEnterPayload {
  instanceId: string;
}

export interface PlanModeExitPayload {
  instanceId: string;
  force?: boolean; // Force exit without approval
}

export interface PlanModeApprovePayload {
  instanceId: string;
  planContent?: string;
}

export interface PlanModeUpdatePayload {
  instanceId: string;
  planContent: string;
}

export interface PlanModeGetStatePayload {
  instanceId: string;
}

// ============================================
// VCS Payloads (Git)
// ============================================

export interface VcsIsRepoPayload {
  workingDirectory: string;
}

export interface VcsGetStatusPayload {
  workingDirectory: string;
}

export interface VcsGetBranchesPayload {
  workingDirectory: string;
}

export interface VcsGetCommitsPayload {
  workingDirectory: string;
  limit?: number;
}

export interface VcsGetDiffPayload {
  workingDirectory: string;
  type: 'staged' | 'unstaged' | 'between';
  fromRef?: string; // For 'between' type
  toRef?: string; // For 'between' type
  filePath?: string; // For single file diff
}

export interface VcsGetFileHistoryPayload {
  workingDirectory: string;
  filePath: string;
  limit?: number;
}

export interface VcsGetFileAtCommitPayload {
  workingDirectory: string;
  filePath: string;
  commitHash: string;
}

export interface VcsGetBlamePayload {
  workingDirectory: string;
  filePath: string;
}

// ============================================
// Snapshot Payloads (File Revert)
// ============================================

export interface SnapshotTakePayload {
  filePath: string;
  instanceId: string;
  sessionId?: string;
  action?: 'create' | 'modify' | 'delete';
}

export interface SnapshotStartSessionPayload {
  instanceId: string;
  description?: string;
}

export interface SnapshotEndSessionPayload {
  sessionId: string;
}

export interface SnapshotGetForInstancePayload {
  instanceId: string;
}

export interface SnapshotGetForFilePayload {
  filePath: string;
}

export interface SnapshotGetSessionsPayload {
  instanceId: string;
}

export interface SnapshotGetContentPayload {
  snapshotId: string;
}

export interface SnapshotRevertFilePayload {
  snapshotId: string;
}

export interface SnapshotRevertSessionPayload {
  sessionId: string;
}

export interface SnapshotGetDiffPayload {
  snapshotId: string;
}

export interface SnapshotDeletePayload {
  snapshotId: string;
}

export interface SnapshotCleanupPayload {
  maxAgeDays?: number;
}

// ============================================
// TODO Payloads
// ============================================

export interface TodoGetListPayload {
  sessionId: string;
}

export interface TodoCreatePayload {
  sessionId: string;
  content: string;
  activeForm?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  parentId?: string;
}

export interface TodoUpdatePayload {
  sessionId: string;
  todoId: string;
  content?: string;
  activeForm?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'critical';
}

export interface TodoDeletePayload {
  sessionId: string;
  todoId: string;
}

export interface TodoWriteAllPayload {
  sessionId: string;
  todos: Array<{
    content: string;
    status: string;
    activeForm?: string;
  }>;
}

export interface TodoClearPayload {
  sessionId: string;
}

export interface TodoGetCurrentPayload {
  sessionId: string;
}

// ============================================
// MCP Payloads
// ============================================

export interface McpServerPayload {
  serverId: string;
}

export interface McpAddServerPayload {
  id: string;
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect?: boolean;
}

export interface McpCallToolPayload {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface McpReadResourcePayload {
  serverId: string;
  uri: string;
}

export interface McpGetPromptPayload {
  serverId: string;
  promptName: string;
  arguments?: Record<string, string>;
}

export interface McpStateChangedPayload {
  type: 'server' | 'tools' | 'resources' | 'prompts';
  serverId?: string;
}

export interface McpServerStatusChangedPayload {
  serverId: string;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

// ============================================
// LSP Payloads
// ============================================

export interface LspPositionPayload {
  filePath: string;
  line: number; // 0-based
  character: number; // 0-based
}

export interface LspFindReferencesPayload extends LspPositionPayload {
  includeDeclaration?: boolean;
}

export interface LspFilePayload {
  filePath: string;
}

export interface LspWorkspaceSymbolPayload {
  query: string;
  rootPath: string;
}

// ============================================
// Multi-Edit Payloads
// ============================================

export interface MultiEditOperation {
  filePath: string; // Absolute path to the file
  oldString: string; // Text to find and replace
  newString: string; // Replacement text
  replaceAll?: boolean; // Replace all occurrences (default: false)
}

export interface MultiEditPayload {
  edits: MultiEditOperation[];
  instanceId?: string;
  takeSnapshots?: boolean;
}

// ============================================
// Task Management Payloads (Subagent Spawning)
// ============================================

export interface TaskGetStatusPayload {
  taskId: string;
}

export interface TaskGetHistoryPayload {
  parentId?: string; // If provided, get history for this parent only
  limit?: number;
}

export interface TaskGetByParentPayload {
  parentId: string;
}

export interface TaskGetByChildPayload {
  childId: string;
}

export interface TaskCancelPayload {
  taskId: string;
}

// ============================================
// Security Payloads (Secret Detection & Environment Filtering)
// ============================================

export interface SecurityDetectSecretsPayload {
  content: string;
  contentType?: 'env' | 'text' | 'auto'; // auto = detect based on content
}

export interface SecurityRedactContentPayload {
  content: string;
  contentType?: 'env' | 'text' | 'auto';
  options?: {
    maskChar?: string;
    showStart?: number;
    showEnd?: number;
    fullMask?: boolean;
    label?: string;
  };
}

export interface SecurityCheckFilePayload {
  filePath: string;
}

export interface SecurityGetAuditLogPayload {
  instanceId?: string; // If provided, filter by instance
  limit?: number;
}

export interface SecurityCheckEnvVarPayload {
  name: string;
  value: string;
}

export interface SecurityUpdateEnvFilterConfigPayload {
  blocklist?: string[];
  allowlist?: string[];
  blockPatterns?: string[]; // Regex patterns as strings
  allowPatterns?: string[]; // Regex patterns as strings
  blockAllSecrets?: boolean;
}

// ============================================
// Cost Tracking Payloads (5.3)
// ============================================

export interface CostRecordUsagePayload {
  instanceId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  ipcAuthToken?: string;
}

export interface CostGetSummaryPayload {
  startTime?: number;
  endTime?: number;
  ipcAuthToken?: string;
}

export interface CostGetSessionCostPayload {
  sessionId: string;
  ipcAuthToken?: string;
}

export interface CostSetBudgetPayload {
  enabled?: boolean;
  dailyLimit?: number;
  weeklyLimit?: number;
  monthlyLimit?: number;
  perSessionLimit?: number;
  alertThresholds?: number[];
  ipcAuthToken?: string;
}

export interface CostGetBudgetPayload {
  ipcAuthToken?: string;
}

export interface CostGetBudgetStatusPayload {
  ipcAuthToken?: string;
}

export interface CostGetEntriesPayload {
  limit?: number;
  ipcAuthToken?: string;
}

export interface CostClearEntriesPayload {
  ipcAuthToken?: string;
}

// ============================================
// Session Archiving Payloads (1.3)
// ============================================

export interface ArchiveSessionPayload {
  instanceId: string;
  tags?: string[];
}

export interface ArchiveRestorePayload {
  sessionId: string;
}

export interface ArchiveDeletePayload {
  sessionId: string;
}

export interface ArchiveListPayload {
  beforeDate?: number;
  afterDate?: number;
  tags?: string[];
  searchTerm?: string;
}

export interface ArchiveGetMetaPayload {
  sessionId: string;
}

export interface ArchiveUpdateTagsPayload {
  sessionId: string;
  tags: string[];
}

export interface ArchiveCleanupPayload {
  maxAgeDays: number;
}

// ============================================
// Remote Configuration Payloads (6.2)
// ============================================

export interface RemoteConfigFetchUrlPayload {
  url: string;
  timeout?: number;
  cacheTTL?: number;
  maxRetries?: number;
  useCache?: boolean;
}

export interface RemoteConfigFetchWellKnownPayload {
  domain: string;
  timeout?: number;
  cacheTTL?: number;
}

export interface RemoteConfigFetchGitHubPayload {
  owner: string;
  repo: string;
  branch?: string;
}

export interface RemoteConfigDiscoverGitPayload {
  gitRemoteUrl: string;
}

export interface RemoteConfigInvalidatePayload {
  url: string;
}

// ============================================
// External Editor Payloads (9.2)
// ============================================

export interface EditorOpenFilePayload {
  filePath: string;
  line?: number;
  column?: number;
  waitForClose?: boolean;
  newWindow?: boolean;
}

export interface EditorOpenFileAtLinePayload {
  filePath: string;
  line: number;
  column?: number;
}

export interface EditorOpenDirectoryPayload {
  dirPath: string;
}

export interface EditorSetPreferredPayload {
  type: string;
  path?: string;
  args?: string[];
}

// ============================================
// File Watcher Payloads (10.1)
// ============================================

export interface WatcherStartPayload {
  directory: string;
  ignored?: string[];
  useGitignore?: boolean;
  depth?: number;
  ignoreInitial?: boolean;
  debounceMs?: number;
}

export interface WatcherStopPayload {
  sessionId: string;
}

export interface WatcherGetChangesPayload {
  sessionId: string;
  limit?: number;
}

export interface WatcherClearBufferPayload {
  sessionId: string;
}

// ============================================
// File Explorer Payloads
// ============================================

export interface FileReadDirPayload {
  path: string;
  includeHidden?: boolean;
}

export interface FileReadDirResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  modifiedAt: number;
  extension?: string;
}

export interface FileGetStatsPayload {
  path: string;
}

// ============================================
// Structured Logging Payloads (13.1)
// ============================================

export interface LogGetRecentPayload {
  limit?: number;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  subsystem?: string;
  startTime?: number;
  endTime?: number;
}

export interface LogSetLevelPayload {
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export interface LogSetSubsystemLevelPayload {
  subsystem: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
}

export interface LogExportPayload {
  filePath: string;
  startTime?: number;
  endTime?: number;
}

// ============================================
// Debug Commands Payloads (13.2)
// ============================================

export interface DebugAgentPayload {
  agentId?: string;
}

export interface DebugConfigPayload {
  workingDirectory?: string;
}

export interface DebugFilePayload {
  filePath: string;
}

export interface DebugAllPayload {
  workingDirectory?: string;
}

// ============================================
// Usage Statistics Payloads (14.1)
// ============================================

export interface StatsGetPayload {
  period: 'day' | 'week' | 'month' | 'year' | 'all';
}

export interface StatsGetSessionPayload {
  sessionId: string;
}

export interface StatsRecordSessionStartPayload {
  sessionId: string;
  instanceId: string;
  agentId: string;
  workingDirectory: string;
}

export interface StatsRecordSessionEndPayload {
  sessionId: string;
}

export interface StatsRecordMessagePayload {
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface StatsRecordToolUsagePayload {
  sessionId: string;
  tool: string;
}

export interface StatsExportPayload {
  filePath: string;
  period?: 'day' | 'week' | 'month' | 'year' | 'all';
}

// ============================================
// Semantic Search Payloads (4.7)
// ============================================

export interface SearchSemanticPayload {
  query: string;
  directory: string;
  maxResults?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  searchType?: 'semantic' | 'hybrid' | 'keyword';
  minScore?: number;
}

export interface SearchBuildIndexPayload {
  directory: string;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export interface SearchConfigureExaPayload {
  apiKey: string;
  baseUrl?: string;
}

// ============================================
// Provider Plugins Payloads (12.2)
// ============================================

export interface PluginsLoadPayload {
  idOrPath: string;
  timeout?: number;
  sandbox?: boolean;
}

export interface PluginsUnloadPayload {
  pluginId: string;
}

export interface PluginsGetPayload {
  pluginId: string;
}

export interface PluginsGetMetaPayload {
  pluginId: string;
}

export interface PluginsInstallPayload {
  sourcePath: string;
}

export interface PluginsUninstallPayload {
  pluginId: string;
}

export interface PluginsCreateTemplatePayload {
  name: string;
}

// ============================================
// Workflow Payloads (6.1)
// ============================================

export interface WorkflowGetTemplatePayload {
  templateId: string;
}

export interface WorkflowStartPayload {
  instanceId: string;
  templateId: string;
}

export interface WorkflowGetExecutionPayload {
  executionId: string;
}

export interface WorkflowGetByInstancePayload {
  instanceId: string;
}

export interface WorkflowCompletePhasePayload {
  executionId: string;
  phaseData?: Record<string, unknown>;
}

export interface WorkflowSatisfyGatePayload {
  executionId: string;
  response: {
    approved?: boolean;
    selection?: string;
    answer?: string;
  };
}

export interface WorkflowSkipPhasePayload {
  executionId: string;
}

export interface WorkflowCancelPayload {
  executionId: string;
}

export interface WorkflowGetPromptAdditionPayload {
  executionId: string;
}

// ============================================
// Review Agent Payloads (6.2)
// ============================================

export interface ReviewGetAgentPayload {
  agentId: string;
}

export interface ReviewStartSessionPayload {
  instanceId: string;
  agentIds: string[];
  files: string[];
  diffOnly?: boolean;
}

export interface ReviewGetSessionPayload {
  sessionId: string;
}

export interface ReviewGetIssuesPayload {
  sessionId: string;
  severity?: string;
  agentId?: string;
}

export interface ReviewAcknowledgeIssuePayload {
  sessionId: string;
  issueId: string;
  acknowledged: boolean;
}

// ============================================
// Hook Payloads (6.3)
// ============================================

export interface HooksListPayload {
  event?: string;
  source?: 'built-in' | 'project' | 'user';
}

export interface HooksGetPayload {
  ruleId: string;
}

export interface HooksCreatePayload {
  rule: {
    name: string;
    enabled: boolean;
    event: string;
    toolMatcher?: string;
    conditions: Array<{
      field: string;
      operator: string;
      pattern: string;
    }>;
    action: 'warn' | 'block';
    message: string;
  };
}

export interface HooksUpdatePayload {
  ruleId: string;
  updates: {
    name?: string;
    enabled?: boolean;
    conditions?: Array<{
      field: string;
      operator: string;
      pattern: string;
    }>;
    action?: 'warn' | 'block';
    message?: string;
  };
}

export interface HooksDeletePayload {
  ruleId: string;
}

export interface HooksEvaluatePayload {
  context: {
    event: string;
    sessionId: string;
    instanceId: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    filePath?: string;
    newContent?: string;
    command?: string;
    userPrompt?: string;
  };
}

export interface HooksImportPayload {
  rules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    event: string;
    toolMatcher?: string;
    conditions: Array<{
      field: string;
      operator: string;
      pattern: string;
    }>;
    action: 'warn' | 'block';
    message: string;
    source: 'built-in' | 'project' | 'user';
    createdAt: number;
  }>;
  overwrite?: boolean;
}

export interface HooksExportPayload {
  source?: 'built-in' | 'project' | 'user';
}

export interface HookApprovalsListPayload {
  pendingOnly?: boolean;
}

export interface HookApprovalsUpdatePayload {
  hookId: string;
  approved: boolean;
}

export interface HookApprovalsClearPayload {
  hookIds?: string[];
}

// ============================================
// Skill Payloads (6.4)
// ============================================

export interface SkillsDiscoverPayload {
  searchPaths: string[];
}

export interface SkillsGetPayload {
  skillId: string;
}

export interface SkillsLoadPayload {
  skillId: string;
}

export interface SkillsUnloadPayload {
  skillId: string;
}

export interface SkillsLoadReferencePayload {
  skillId: string;
  referencePath: string;
}

export interface SkillsLoadExamplePayload {
  skillId: string;
  examplePath: string;
}

export interface SkillsMatchPayload {
  text: string;
}

// ============================================
// Git Worktree Payloads (7.1)
// ============================================

export interface WorktreeCreatePayload {
  instanceId: string;
  basePath: string;
  taskDescription: string;
  baseBranch?: string;
  config?: {
    prefix?: string;
    cleanupOnComplete?: boolean;
    syncIntervalMs?: number;
    conflictStrategy?: 'merge' | 'rebase' | 'manual';
    trackRemote?: boolean;
  };
}

export interface WorktreeCompletePayload {
  sessionId: string;
}

export interface WorktreePreviewMergePayload {
  sessionId: string;
}

export interface WorktreeMergePayload {
  sessionId: string;
  strategy?: 'merge' | 'squash' | 'rebase';
  commitMessage?: string;
}

export interface WorktreeCleanupPayload {
  sessionId: string;
}

export interface WorktreeAbandonPayload {
  sessionId: string;
  reason?: string;
}

export interface WorktreeGetSessionPayload {
  sessionId: string;
}

export interface WorktreeDetectConflictsPayload {
  sessionIds: string[];
}

export interface WorktreeSyncPayload {
  sessionId: string;
}

// ============================================
// Multi-Agent Verification Payloads (7.2)
// ============================================

export interface VerifyStartPayload {
  instanceId: string;
  prompt: string;
  context?: string;
  taskType?: string;
  config?: {
    minAgents?: number;
    synthesisStrategy?:
      | 'consensus'
      | 'best-of'
      | 'merge'
      | 'majority-vote'
      | 'debate'
      | 'hierarchical';
    personalities?: string[];
    confidenceThreshold?: number;
    timeoutMs?: number;
    maxDebateRounds?: number;
  };
}

export interface VerifyGetResultPayload {
  verificationId: string;
}

export interface VerifyGetActivePayload {
  instanceId?: string;
}

export interface VerifyCancelPayload {
  verificationId: string;
}

export interface VerifyConfigurePayload {
  config: {
    minAgents?: number;
    synthesisStrategy?:
      | 'consensus'
      | 'best-of'
      | 'merge'
      | 'majority-vote'
      | 'debate'
      | 'hierarchical';
    confidenceThreshold?: number;
    timeoutMs?: number;
    enableByDefault?: boolean;
  };
}

// ============================================
// Cascade Supervision Payloads (7.3)
// ============================================

export interface SupervisionCreateTreePayload {
  instanceId: string;
  config?: {
    strategy?: 'one-for-one' | 'one-for-all' | 'rest-for-one' | 'simple-one';
    maxRestarts?: number;
    maxTime?: number;
    onExhausted?: 'restart' | 'escalate' | 'ignore' | 'stop';
    backoff?: {
      minDelayMs?: number;
      maxDelayMs?: number;
      factor?: number;
      jitter?: boolean;
    };
    healthCheck?: {
      intervalMs?: number;
      timeoutMs?: number;
      unhealthyThreshold?: number;
    };
  };
}

export interface SupervisionAddWorkerPayload {
  instanceId: string;
  spec: {
    id: string;
    name: string;
    restartType: 'permanent' | 'transient' | 'temporary';
    startFuncId: string;
    stopFuncId?: string;
    dependencies?: string[];
    order?: number;
  };
  parentId?: string;
}

export interface SupervisionStartWorkerPayload {
  instanceId: string;
  workerId: string;
}

export interface SupervisionStopWorkerPayload {
  instanceId: string;
  workerId: string;
}

export interface SupervisionHandleFailurePayload {
  instanceId: string;
  childInstanceId: string;
  error: string;
}

export interface SupervisionGetTreePayload {
  instanceId: string;
}

export interface SupervisionGetHealthPayload {
  instanceId: string;
}

// ============================================
// Specialist Payloads (7.4)
// ============================================

export interface SpecialistGetPayload {
  profileId: string;
}

export interface SpecialistGetByCategoryPayload {
  category: string;
}

export interface SpecialistAddCustomPayload {
  profile: {
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
  };
}

export interface SpecialistUpdateCustomPayload {
  profileId: string;
  updates: {
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
  };
}

export interface SpecialistRemoveCustomPayload {
  profileId: string;
}

export interface SpecialistRecommendPayload {
  context: {
    taskDescription?: string;
    fileTypes?: string[];
    userPreferences?: string[];
  };
}

export interface SpecialistCreateInstancePayload {
  profileId: string;
  orchestratorInstanceId: string;
}

export interface SpecialistGetInstancePayload {
  instanceId: string;
}

export interface SpecialistUpdateStatusPayload {
  instanceId: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
}

export interface SpecialistAddFindingPayload {
  instanceId: string;
  finding: {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    filePath?: string;
    lineRange?: {
      start: number;
      end: number;
    };
    codeSnippet?: string;
    suggestion?: string;
    confidence: number;
    tags?: string[];
  };
}

export interface SpecialistUpdateMetricsPayload {
  instanceId: string;
  updates: {
    filesAnalyzed?: number;
    linesAnalyzed?: number;
    findingsCount?: number;
    tokensUsed?: number;
    durationMs?: number;
  };
}

export interface SpecialistGetPromptAdditionPayload {
  profileId: string;
}

// ============================================
// LLM Service Payloads
// ============================================

export interface LLMSummarizePayload {
  requestId: string;
  content: string;
  targetTokens: number;
  preserveKeyPoints?: boolean;
}

export interface LLMSubQueryPayload {
  requestId: string;
  prompt: string;
  context: string;
  depth: number;
}

export interface LLMCancelStreamPayload {
  requestId: string;
}

export interface LLMCountTokensPayload {
  text: string;
  model?: string;
}

export interface LLMTruncateTokensPayload {
  text: string;
  maxTokens: number;
  model?: string;
}

export interface LLMSetConfigPayload {
  provider?: 'anthropic' | 'ollama' | 'openai' | 'local';
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ollamaHost?: string;
}

export interface LLMStreamChunkPayload {
  requestId: string;
  chunk: string;
  done: boolean;
  error?: string;
}
