// AUTO-GENERATED — do not edit manually.
// Source: packages/contracts/src/channels/*.channels.ts
// Regenerate: npm run generate:ipc

export const IPC_CHANNELS = {
  // Instance management
  INSTANCE_CREATE: 'instance:create',
  INSTANCE_CREATE_WITH_MESSAGE: 'instance:create-with-message',
  INSTANCE_TERMINATE: 'instance:terminate',
  INSTANCE_TERMINATE_ALL: 'instance:terminate-all',
  INSTANCE_RESTART: 'instance:restart',
  INSTANCE_RESTART_FRESH: 'instance:restart-fresh',
  INSTANCE_RENAME: 'instance:rename',
  INSTANCE_CHANGE_AGENT_MODE: 'instance:change-agent-mode',
  INSTANCE_TOGGLE_YOLO_MODE: 'instance:toggle-yolo-mode',
  INSTANCE_CHANGE_MODEL: 'instance:change-model',
  INSTANCE_SEND_INPUT: 'instance:send-input',
  INSTANCE_INTERRUPT: 'instance:interrupt',
  INSTANCE_STATE_UPDATE: 'instance:state-update',
  INSTANCE_BATCH_UPDATE: 'instance:batch-update',
  INSTANCE_CREATED: 'instance:created',
  INSTANCE_REMOVED: 'instance:removed',
  INSTANCE_LIST: 'instance:list',
  INSTANCE_LOAD_OLDER_MESSAGES: 'instance:load-older-messages',

  // Hibernation lifecycle
  INSTANCE_HIBERNATE: 'instance:hibernate',
  INSTANCE_HIBERNATED: 'instance:hibernated',
  INSTANCE_WAKE: 'instance:wake',
  INSTANCE_WAKING: 'instance:waking',
  INSTANCE_TRANSCRIPT_CHUNK: 'instance:transcript-chunk',

  // Context compaction
  INSTANCE_COMPACT: 'instance:compact',
  INSTANCE_COMPACT_STATUS: 'instance:compact-status',
  CONTEXT_WARNING: 'context:warning',

  // Input required events (CLI permission prompts, etc.)
  INPUT_REQUIRED: 'instance:input-required',
  INPUT_REQUIRED_RESPOND: 'instance:input-required-respond',

  // File operations
  FILE_DROP: 'file:drop',
  FILE_READ_DIR: 'file:read-dir',
  FILE_GET_STATS: 'file:get-stats',
  FILE_READ_TEXT: 'file:read-text',
  FILE_WRITE_TEXT: 'file:write-text',
  FILE_OPEN_PATH: 'file:open-path',

  // Ecosystem operations (file-based extensibility)
  ECOSYSTEM_LIST: 'ecosystem:list',
  ECOSYSTEM_WATCH_START: 'ecosystem:watch-start',
  ECOSYSTEM_WATCH_STOP: 'ecosystem:watch-stop',
  ECOSYSTEM_CHANGED: 'ecosystem:changed',

  // External Editor
  EDITOR_DETECT: 'editor:detect',
  EDITOR_OPEN: 'editor:open',
  EDITOR_OPEN_FILE: 'editor:open-file',
  EDITOR_OPEN_FILE_AT_LINE: 'editor:open-file-at-line',
  EDITOR_OPEN_DIRECTORY: 'editor:open-directory',
  EDITOR_SET_PREFERRED: 'editor:set-preferred',
  EDITOR_SET_DEFAULT: 'editor:set-default',
  EDITOR_GET_PREFERRED: 'editor:get-preferred',
  EDITOR_GET_DEFAULT: 'editor:get-default',
  EDITOR_GET_AVAILABLE: 'editor:get-available',

  // Dialog operations
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILES: 'dialog:select-files',

  // Image operations
  IMAGE_PASTE: 'image:paste',
  IMAGE_COPY_TO_CLIPBOARD: 'image:copy-to-clipboard',
  IMAGE_CONTEXT_MENU: 'image:context-menu',
  IMAGE_RESOLVE: 'image:resolve',

  // File Watcher
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_STOP_ALL: 'watcher:stop-all',
  WATCHER_WATCH: 'watcher:watch',
  WATCHER_UNWATCH: 'watcher:unwatch',
  WATCHER_GET_ACTIVE: 'watcher:get-active',
  WATCHER_GET_SESSIONS: 'watcher:get-sessions',
  WATCHER_GET_CHANGES: 'watcher:get-changes',
  WATCHER_CLEAR_BUFFER: 'watcher:clear-buffer',
  WATCHER_FILE_CHANGED: 'watcher:file-changed',
  WATCHER_ERROR: 'watcher:error',

  // Session operations
  SESSION_FORK: 'session:fork',
  SESSION_EXPORT: 'session:export',
  SESSION_IMPORT: 'session:import',
  SESSION_COPY_TO_CLIPBOARD: 'session:copy-to-clipboard',
  SESSION_SAVE_TO_FILE: 'session:save-to-file',
  SESSION_REVEAL_FILE: 'session:reveal-file',
  SESSION_SHARE_PREVIEW: 'session:share-preview',
  SESSION_SHARE_SAVE: 'session:share-save',
  SESSION_SHARE_LOAD: 'session:share-load',
  SESSION_SHARE_REPLAY: 'session:share-replay',
  SESSION_LIST_RESUMABLE: 'session:list-resumable',
  SESSION_RESUME: 'session:resume',
  SESSION_LIST_SNAPSHOTS: 'session:list-snapshots',
  SESSION_CREATE_SNAPSHOT: 'session:create-snapshot',
  SESSION_GET_STATS: 'session:get-stats',

  // Snapshot operations (file revert)
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

  // Session Archiving
  ARCHIVE_SESSION: 'archive:session',
  ARCHIVE_RESTORE: 'archive:restore',
  ARCHIVE_DELETE: 'archive:delete',
  ARCHIVE_LIST: 'archive:list',
  ARCHIVE_SEARCH: 'archive:search',
  ARCHIVE_GET_META: 'archive:get-meta',
  ARCHIVE_UPDATE_TAGS: 'archive:update-tags',
  ARCHIVE_GET_STATS: 'archive:get-stats',
  ARCHIVE_CLEANUP: 'archive:cleanup',

  // History operations
  HISTORY_LIST: 'history:list',
  HISTORY_LOAD: 'history:load',
  HISTORY_ARCHIVE: 'history:archive',
  HISTORY_DELETE: 'history:delete',
  HISTORY_RESTORE: 'history:restore',
  HISTORY_CLEAR: 'history:clear',

  // Orchestration activity (real-time status updates)
  ORCHESTRATION_ACTIVITY: 'orchestration:activity',
  SUPERVISOR_STATUS: 'supervisor:status',
  SUPERVISOR_METRICS: 'supervisor:metrics',

  // Multi-Agent Verification operations
  VERIFY_START: 'verify:start',
  VERIFY_GET_RESULT: 'verify:get-result',
  VERIFY_GET_ACTIVE: 'verify:get-active',
  VERIFY_CANCEL: 'verify:cancel',
  VERIFY_GET_PERSONALITIES: 'verify:get-personalities',
  VERIFY_CONFIGURE: 'verify:configure',
  VERIFY_STARTED: 'verify:started',
  VERIFY_AGENT_RESPONDED: 'verify:agent-responded',
  VERIFY_COMPLETED: 'verify:completed',

  // Verification operations (Phase 8.3 - alternative naming)
  VERIFICATION_VERIFY_MULTI: 'verification:verify-multi',
  VERIFICATION_START_CLI: 'verification:start-cli',
  VERIFICATION_CANCEL: 'verification:cancel',
  VERIFICATION_GET_ACTIVE: 'verification:get-active',
  VERIFICATION_GET_RESULT: 'verification:get-result',

  // Verification streaming events
  VERIFICATION_AGENT_START: 'verification:agent-start',
  VERIFICATION_AGENT_STREAM: 'verification:agent-stream',
  VERIFICATION_AGENT_COMPLETE: 'verification:agent-complete',
  VERIFICATION_AGENT_ERROR: 'verification:agent-error',
  VERIFICATION_ROUND_PROGRESS: 'verification:round-progress',
  VERIFICATION_CONSENSUS_UPDATE: 'verification:consensus-update',
  VERIFICATION_COMPLETE: 'verification:complete',
  VERIFICATION_ERROR: 'verification:error',

  // Verification event forwarding (main -> renderer)
  VERIFICATION_EVENT_STARTED: 'verification:event:started',
  VERIFICATION_EVENT_PROGRESS: 'verification:event:progress',
  VERIFICATION_EVENT_COMPLETED: 'verification:event:completed',
  VERIFICATION_EVENT_ERROR: 'verification:event:error',

  // Debate operations
  DEBATE_START: 'debate:start',
  DEBATE_GET_RESULT: 'debate:get-result',
  DEBATE_GET_ACTIVE: 'debate:get-active',
  DEBATE_CANCEL: 'debate:cancel',
  DEBATE_GET_STATS: 'debate:get-stats',
  DEBATE_PAUSE: 'debate:pause',
  DEBATE_RESUME: 'debate:resume',
  DEBATE_STOP: 'debate:stop',
  DEBATE_INTERVENE: 'debate:intervene',
  DEBATE_EVENT: 'debate:event',

  // Debate event forwarding (main -> renderer)
  DEBATE_EVENT_STARTED: 'debate:event:started',
  DEBATE_EVENT_ROUND_COMPLETE: 'debate:event:round-complete',
  DEBATE_EVENT_COMPLETED: 'debate:event:completed',
  DEBATE_EVENT_ERROR: 'debate:event:error',
  DEBATE_EVENT_PAUSED: 'debate:event:paused',
  DEBATE_EVENT_RESUMED: 'debate:event:resumed',

  // Consensus operations
  CONSENSUS_QUERY: 'consensus:query',
  CONSENSUS_ABORT: 'consensus:abort',
  CONSENSUS_GET_ACTIVE: 'consensus:get-active',

  // Cascade Supervision operations
  SUPERVISION_CREATE_TREE: 'supervision:create-tree',
  SUPERVISION_ADD_WORKER: 'supervision:add-worker',
  SUPERVISION_START_WORKER: 'supervision:start-worker',
  SUPERVISION_STOP_WORKER: 'supervision:stop-worker',
  SUPERVISION_HANDLE_FAILURE: 'supervision:handle-failure',
  SUPERVISION_GET_TREE: 'supervision:get-tree',
  SUPERVISION_GET_HEALTH: 'supervision:get-health',
  SUPERVISION_GET_HIERARCHY: 'supervision:get-hierarchy',
  SUPERVISION_GET_ALL_REGISTRATIONS: 'supervision:get-all-registrations',
  SUPERVISION_EXHAUSTED: 'supervision:exhausted',
  SUPERVISION_HEALTH_CHANGED: 'supervision:health-changed',
  SUPERVISION_HEALTH_GLOBAL: 'supervision:health-global',
  SUPERVISION_TREE_UPDATED: 'supervision:tree-updated',
  SUPERVISION_WORKER_FAILED: 'supervision:worker-failed',
  SUPERVISION_WORKER_RESTARTED: 'supervision:worker-restarted',
  SUPERVISION_CIRCUIT_BREAKER_CHANGED: 'supervision:circuit-breaker-changed',

  // Workflow operations
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

  // Review agent operations
  REVIEW_LIST_AGENTS: 'review:list-agents',
  REVIEW_GET_AGENT: 'review:get-agent',
  REVIEW_START_SESSION: 'review:start-session',
  REVIEW_GET_SESSION: 'review:get-session',
  REVIEW_GET_ISSUES: 'review:get-issues',
  REVIEW_ACKNOWLEDGE_ISSUE: 'review:acknowledge-issue',
  REVIEW_SESSION_STARTED: 'review:session-started',
  REVIEW_SESSION_COMPLETED: 'review:session-completed',

  // Cross-Model Review
  CROSS_MODEL_REVIEW_RESULT: 'cross-model-review:result',
  CROSS_MODEL_REVIEW_STARTED: 'cross-model-review:started',
  CROSS_MODEL_REVIEW_ALL_UNAVAILABLE: 'cross-model-review:all-unavailable',
  CROSS_MODEL_REVIEW_STATUS: 'cross-model-review:status',
  CROSS_MODEL_REVIEW_DISMISS: 'cross-model-review:dismiss',
  CROSS_MODEL_REVIEW_ACTION: 'cross-model-review:action',

  // Hook operations
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

  // Skill operations
  SKILLS_DISCOVER: 'skills:discover',
  SKILLS_LIST: 'skills:list',
  SKILLS_GET: 'skills:get',
  SKILLS_LOAD: 'skills:load',
  SKILLS_UNLOAD: 'skills:unload',
  SKILLS_LOAD_REFERENCE: 'skills:load-reference',
  SKILLS_LOAD_EXAMPLE: 'skills:load-example',
  SKILLS_MATCH: 'skills:match',
  SKILLS_GET_MEMORY: 'skills:get-memory',

  // User action requests (orchestrator -> user)
  USER_ACTION_REQUEST: 'user-action:request',
  USER_ACTION_RESPOND: 'user-action:respond',
  USER_ACTION_LIST: 'user-action:list',
  USER_ACTION_LIST_FOR_INSTANCE: 'user-action:list-for-instance',
  USER_ACTION_RESPONSE: 'user-action-response',

  // Plan mode operations
  PLAN_MODE_ENTER: 'plan:enter',
  PLAN_MODE_EXIT: 'plan:exit',
  PLAN_MODE_APPROVE: 'plan:approve',
  PLAN_MODE_UPDATE: 'plan:update',
  PLAN_MODE_GET_STATE: 'plan:get-state',

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

  // Command operations
  COMMAND_LIST: 'command:list',
  COMMAND_EXECUTE: 'command:execute',
  COMMAND_CREATE: 'command:create',
  COMMAND_UPDATE: 'command:update',
  COMMAND_DELETE: 'command:delete',

  // Menu events (renderer-bound)
  MENU_NEW_INSTANCE: 'menu:new-instance',
  MENU_OPEN_SETTINGS: 'menu:open-settings',

  // Memory management (process memory)
  MEMORY_GET_STATS: 'memory:get-stats',
  MEMORY_STATS_UPDATE: 'memory:stats-update',
  MEMORY_WARNING: 'memory:warning',
  MEMORY_CRITICAL: 'memory:critical',
  MEMORY_LOAD_HISTORY: 'memory:load-history',

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

  // RLM Context Management operations
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
  RLM_GET_TOKEN_SAVINGS_HISTORY: 'rlm:get-token-savings-history',
  RLM_GET_QUERY_STATS: 'rlm:get-query-stats',
  RLM_GET_STORAGE_STATS: 'rlm:get-storage-stats',

  // RLM events (renderer-bound)
  RLM_STORE_UPDATED: 'rlm:store-updated',
  RLM_SECTION_ADDED: 'rlm:section-added',
  RLM_SECTION_REMOVED: 'rlm:section-removed',
  RLM_QUERY_COMPLETE: 'rlm:query-complete',

  // Observation Memory operations
  OBSERVATION_GET_STATS: 'observation:get-stats',
  OBSERVATION_GET_REFLECTIONS: 'observation:get-reflections',
  OBSERVATION_GET_OBSERVATIONS: 'observation:get-observations',
  OBSERVATION_CONFIGURE: 'observation:configure',
  OBSERVATION_GET_CONFIG: 'observation:get-config',
  OBSERVATION_FORCE_REFLECT: 'observation:force-reflect',
  OBSERVATION_CLEANUP: 'observation:cleanup',

  // Token Stats operations
  TOKEN_STATS_GET_SUMMARY: 'token-stats:get-summary',
  TOKEN_STATS_GET_RECENT: 'token-stats:get-recent',
  TOKEN_STATS_CLEANUP: 'token-stats:cleanup',

  // Knowledge Graph operations
  KG_ADD_FACT: 'kg:add-fact',
  KG_INVALIDATE_FACT: 'kg:invalidate-fact',
  KG_QUERY_ENTITY: 'kg:query-entity',
  KG_QUERY_RELATIONSHIP: 'kg:query-relationship',
  KG_GET_TIMELINE: 'kg:get-timeline',
  KG_GET_STATS: 'kg:get-stats',
  KG_ADD_ENTITY: 'kg:add-entity',

  // Conversation Mining operations
  CONVO_IMPORT_FILE: 'convo:import-file',
  CONVO_IMPORT_STRING: 'convo:import-string',
  CONVO_DETECT_FORMAT: 'convo:detect-format',

  // Wake Context operations
  WAKE_GENERATE: 'wake:generate',
  WAKE_GET_TEXT: 'wake:get-text',
  WAKE_ADD_HINT: 'wake:add-hint',
  WAKE_REMOVE_HINT: 'wake:remove-hint',
  WAKE_SET_IDENTITY: 'wake:set-identity',
  WAKE_LIST_HINTS: 'wake:list-hints',

  // Codebase Mining operations
  CODEBASE_MINE_DIRECTORY: 'codebase:mine-directory',
  CODEBASE_GET_STATUS: 'codebase:get-status',

  // Knowledge event forwarding (main -> renderer)
  KG_EVENT_FACT_ADDED: 'kg:event:fact-added',
  KG_EVENT_FACT_INVALIDATED: 'kg:event:fact-invalidated',
  CONVO_EVENT_IMPORT_COMPLETE: 'convo:event:import-complete',
  WAKE_EVENT_HINT_ADDED: 'wake:event:hint-added',
  WAKE_EVENT_CONTEXT_GENERATED: 'wake:event:context-generated',

  // Provider operations
  PROVIDER_LIST: 'provider:list',
  PROVIDER_STATUS: 'provider:status',
  PROVIDER_STATUS_ALL: 'provider:status-all',
  PROVIDER_UPDATE_CONFIG: 'provider:update-config',
  PROVIDER_LIST_MODELS: 'provider:list-models',

  // CLI detection
  CLI_DETECT_ALL: 'cli:detect-all',
  CLI_DETECT_ONE: 'cli:detect-one',
  CLI_CHECK: 'cli:check',
  CLI_TEST_CONNECTION: 'cli:test-connection',
  CLI_SCAN_ALL_INSTALLS: 'cli:scan-all-installs',
  CLI_DIAGNOSE_ALL: 'cli:diagnose-all',
  CLI_UPDATE_ONE: 'cli:update-one',
  CLI_UPDATE_ALL: 'cli:update-all',

  // Copilot operations
  COPILOT_LIST_MODELS: 'copilot:list-models',

  // Provider Plugins
  PLUGINS_DISCOVER: 'plugins:discover',
  PLUGINS_LOAD: 'plugins:load',
  PLUGINS_UNLOAD: 'plugins:unload',
  PLUGINS_GET: 'plugins:get',
  PLUGINS_GET_ALL: 'plugins:get-all',
  PLUGINS_GET_LOADED: 'plugins:get-loaded',
  PLUGINS_GET_META: 'plugins:get-meta',
  PLUGINS_INSTALL: 'plugins:install',
  PLUGINS_UNINSTALL: 'plugins:uninstall',
  PLUGINS_CREATE_TEMPLATE: 'plugins:create-template',

  // Plugin lifecycle events (renderer-bound)
  PLUGINS_LOADED: 'plugins:loaded',
  PLUGINS_UNLOADED: 'plugins:unloaded',
  PLUGINS_ERROR: 'plugins:error',

  // Model Discovery operations
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

  // Model routing operations
  ROUTING_GET_CONFIG: 'routing:get-config',
  ROUTING_UPDATE_CONFIG: 'routing:update-config',
  ROUTING_PREVIEW: 'routing:preview',
  ROUTING_GET_TIER: 'routing:get-tier',
  HOT_SWITCH_GET_CONFIG: 'hot-switch:get-config',
  HOT_SWITCH_UPDATE_CONFIG: 'hot-switch:update-config',
  HOT_SWITCH_PERFORM: 'hot-switch:perform',
  HOT_SWITCH_GET_STATS: 'hot-switch:get-stats',

  // Hot-switch event forwarding (main -> renderer)
  HOT_SWITCH_EVENT_STARTED: 'hot-switch:event:started',
  HOT_SWITCH_EVENT_COMPLETED: 'hot-switch:event:completed',
  HOT_SWITCH_EVENT_FAILED: 'hot-switch:event:failed',

  // Provider runtime event forwarding (main -> renderer)
  PROVIDER_RUNTIME_EVENT: 'provider:runtime-event',

  // App operations
  APP_READY: 'app:ready',
  APP_GET_VERSION: 'app:get-version',
  APP_GET_STARTUP_CAPABILITIES: 'app:get-startup-capabilities',
  APP_STARTUP_CAPABILITIES: 'app:startup-capabilities',
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

  // Provider Quota — remaining usage from each CLI provider
  // (Claude 5h/weekly windows, Copilot monthly premium, etc.)
  QUOTA_GET_ALL: 'quota:get-all',
  QUOTA_GET_PROVIDER: 'quota:get-provider',
  QUOTA_REFRESH: 'quota:refresh',
  QUOTA_REFRESH_ALL: 'quota:refresh-all',
  QUOTA_SET_POLL_INTERVAL: 'quota:set-poll-interval',
  QUOTA_UPDATED: 'quota:updated',
  QUOTA_WARNING: 'quota:warning',
  QUOTA_EXHAUSTED: 'quota:exhausted',

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

  // Cross-instance communication
  COMM_REQUEST_TOKEN: 'comm:request-token',
  COMM_SEND_MESSAGE: 'comm:send-message',
  COMM_SUBSCRIBE: 'comm:subscribe',
  COMM_CONTROL: 'comm:control-instance',
  COMM_CREATE_BRIDGE: 'comm:create-bridge',
  COMM_GET_MESSAGES: 'comm:get-messages',
  COMM_GET_BRIDGES: 'comm:get-bridges',
  COMM_DELETE_BRIDGE: 'comm:delete-bridge',

  // Channel management (request/response)
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',

  // Channel push events (main -> renderer)
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',

  // Reaction Engine
  REACTION_GET_CONFIG: 'reaction:get-config',
  REACTION_UPDATE_CONFIG: 'reaction:update-config',
  REACTION_TRACK_INSTANCE: 'reaction:track-instance',
  REACTION_UNTRACK_INSTANCE: 'reaction:untrack-instance',
  REACTION_GET_TRACKED: 'reaction:get-tracked',
  REACTION_GET_STATE: 'reaction:get-state',
  REACTION_EVENT: 'reaction:event',
  REACTION_ESCALATED: 'reaction:escalated',

  // Remote observer / read-only access
  REMOTE_OBSERVER_GET_STATUS: 'remote-observer:get-status',
  REMOTE_OBSERVER_START: 'remote-observer:start',
  REMOTE_OBSERVER_STOP: 'remote-observer:stop',
  REMOTE_OBSERVER_ROTATE_TOKEN: 'remote-observer:rotate-token',

  // Remote nodes
  REMOTE_NODE_LIST: 'remote-node:list',
  REMOTE_NODE_GET: 'remote-node:get',
  REMOTE_NODE_START_SERVER: 'remote-node:start-server',
  REMOTE_NODE_STOP_SERVER: 'remote-node:stop-server',
  REMOTE_NODE_EVENT: 'remote-node:event',
  REMOTE_NODE_NODES_CHANGED: 'remote-node:nodes-changed',
  REMOTE_NODE_REGENERATE_TOKEN: 'remote-node:regenerate-token',
  REMOTE_NODE_SET_TOKEN: 'remote-node:set-token',
  REMOTE_NODE_ISSUE_PAIRING: 'remote-node:issue-pairing',
  REMOTE_NODE_LIST_PAIRINGS: 'remote-node:list-pairings',
  REMOTE_NODE_REVOKE_PAIRING: 'remote-node:revoke-pairing',
  REMOTE_NODE_REVOKE: 'remote-node:revoke',
  REMOTE_NODE_GET_SERVER_STATUS: 'remote-node:get-server-status',
  REMOTE_NODE_SERVICE_STATUS: 'remote-node:service:status',
  REMOTE_NODE_SERVICE_RESTART: 'remote-node:service:restart',
  REMOTE_NODE_SERVICE_STOP: 'remote-node:service:stop',
  REMOTE_NODE_SERVICE_UNINSTALL: 'remote-node:service:uninstall',

  // Remote Filesystem operations
  REMOTE_FS_READ_DIR: 'remote-fs:read-dir',
  REMOTE_FS_STAT: 'remote-fs:stat',
  REMOTE_FS_SEARCH: 'remote-fs:search',
  REMOTE_FS_WATCH: 'remote-fs:watch',
  REMOTE_FS_UNWATCH: 'remote-fs:unwatch',

  // File transfer (coordinator <-> remote node)
  REMOTE_FS_COPY_TO_REMOTE: 'remote-fs:copy-to-remote',
  REMOTE_FS_COPY_FROM_REMOTE: 'remote-fs:copy-from-remote',
  REMOTE_FS_READ_FILE: 'remote-fs:read-file',
  REMOTE_FS_WRITE_FILE: 'remote-fs:write-file',

  // Directory sync (rsync-style)
  REMOTE_FS_SYNC_START: 'remote-fs:sync-start',
  REMOTE_FS_SYNC_PROGRESS: 'remote-fs:sync-progress',
  REMOTE_FS_SYNC_CANCEL: 'remote-fs:sync-cancel',
  REMOTE_FS_SYNC_DIFF: 'remote-fs:sync-diff',

  // Self-Improvement operations
  LEARNING_RECORD_OUTCOME: 'learning:record-outcome',
  LEARNING_GET_OUTCOME: 'learning:get-outcome',
  LEARNING_GET_RECENT_OUTCOMES: 'learning:get-recent-outcomes',
  LEARNING_GET_EXPERIENCE: 'learning:get-experience',
  LEARNING_GET_ALL_EXPERIENCES: 'learning:get-all-experiences',
  LEARNING_GET_INSIGHTS: 'learning:get-insights',
  LEARNING_GET_PATTERNS: 'learning:get-patterns',
  LEARNING_GET_SUGGESTIONS: 'learning:get-suggestions',
  LEARNING_GET_RECOMMENDATION: 'learning:get-recommendation',
  LEARNING_ENHANCE_PROMPT: 'learning:enhance-prompt',
  LEARNING_GET_STATS: 'learning:get-stats',
  LEARNING_GET_TASK_STATS: 'learning:get-task-stats',
  LEARNING_RATE_OUTCOME: 'learning:rate-outcome',
  LEARNING_CONFIGURE: 'learning:configure',

  // Training operations (GRPO)
  TRAINING_RECORD_OUTCOME: 'training:record-outcome',
  TRAINING_GET_STATS: 'training:get-stats',
  TRAINING_EXPORT_DATA: 'training:export-data',
  TRAINING_IMPORT_DATA: 'training:import-data',
  TRAINING_GET_TREND: 'training:get-trend',
  TRAINING_GET_TOP_STRATEGIES: 'training:get-top-strategies',
  TRAINING_CONFIGURE: 'training:configure',
  TRAINING_GET_REWARD_DATA: 'training:get-reward-data',
  TRAINING_GET_ADVANTAGE_DATA: 'training:get-advantage-data',
  TRAINING_GET_STRATEGIES: 'training:get-strategies',
  TRAINING_GET_AGENT_PERFORMANCE: 'training:get-agent-performance',
  TRAINING_GET_PATTERNS: 'training:get-patterns',
  TRAINING_GET_INSIGHTS: 'training:get-insights',
  TRAINING_APPLY_INSIGHT: 'training:apply-insight',
  TRAINING_DISMISS_INSIGHT: 'training:dismiss-insight',
  TRAINING_UPDATE_CONFIG: 'training:update-config',

  // Training event forwarding (main -> renderer)
  TRAINING_EVENT_STARTED: 'training:event:started',
  TRAINING_EVENT_COMPLETED: 'training:event:completed',
  TRAINING_EVENT_ERROR: 'training:event:error',

  // Specialist operations
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

  // A/B Testing operations
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
  AB_CONFIGURE: 'ab:configure',

  // VCS operations (Git)
  VCS_IS_REPO: 'vcs:is-repo',
  VCS_GET_STATUS: 'vcs:get-status',
  VCS_GET_BRANCHES: 'vcs:get-branches',
  VCS_GET_COMMITS: 'vcs:get-commits',
  VCS_GET_DIFF: 'vcs:get-diff',
  VCS_GET_FILE_HISTORY: 'vcs:get-file-history',
  VCS_GET_FILE_AT_COMMIT: 'vcs:get-file-at-commit',
  VCS_GET_BLAME: 'vcs:get-blame',

  // Git Worktree operations
  WORKTREE_CREATE: 'worktree:create',
  WORKTREE_LIST: 'worktree:list',
  WORKTREE_DELETE: 'worktree:delete',
  WORKTREE_GET_STATUS: 'worktree:get-status',
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

  // Parallel worktree operations
  PARALLEL_WORKTREE_START: 'parallel-worktree:start',
  PARALLEL_WORKTREE_GET_STATUS: 'parallel-worktree:get-status',
  PARALLEL_WORKTREE_CANCEL: 'parallel-worktree:cancel',
  PARALLEL_WORKTREE_GET_RESULTS: 'parallel-worktree:get-results',
  PARALLEL_WORKTREE_LIST: 'parallel-worktree:list',
  PARALLEL_WORKTREE_RESOLVE_CONFLICT: 'parallel-worktree:resolve-conflict',
  PARALLEL_WORKTREE_MERGE: 'parallel-worktree:merge',

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
  MCP_GET_BROWSER_AUTOMATION_HEALTH: 'mcp:get-browser-automation-health',
  MCP_STATE_CHANGED: 'mcp:state-changed',
  MCP_SERVER_STATUS_CHANGED: 'mcp:server-status-changed',

  // Codebase Indexing operations
  CODEBASE_INDEX_STORE: 'codebase:index:store',
  CODEBASE_INDEX_FILE: 'codebase:index:file',
  CODEBASE_INDEX_CANCEL: 'codebase:index:cancel',
  CODEBASE_INDEX_STATUS: 'codebase:index:status',
  CODEBASE_INDEX_STATS: 'codebase:index:stats',
  CODEBASE_INDEX_PROGRESS: 'codebase:index:progress',
  CODEBASE_SEARCH: 'codebase:search',
  CODEBASE_SEARCH_SYMBOLS: 'codebase:search:symbols',
  CODEBASE_WATCHER_START: 'codebase:watcher:start',
  CODEBASE_WATCHER_STOP: 'codebase:watcher:stop',
  CODEBASE_WATCHER_STATUS: 'codebase:watcher:status',
  CODEBASE_WATCHER_CHANGES: 'codebase:watcher:changes',

  // Background repo jobs
  REPO_JOB_SUBMIT: 'repo-job:submit',
  REPO_JOB_LIST: 'repo-job:list',
  REPO_JOB_GET: 'repo-job:get',
  REPO_JOB_CANCEL: 'repo-job:cancel',
  REPO_JOB_RERUN: 'repo-job:rerun',
  REPO_JOB_GET_STATS: 'repo-job:get-stats',

  // Task management (subagent spawning)
  TASK_GET_STATUS: 'task:get-status',
  TASK_GET_HISTORY: 'task:get-history',
  TASK_GET_BY_PARENT: 'task:get-by-parent',
  TASK_GET_BY_CHILD: 'task:get-by-child',
  TASK_CANCEL: 'task:cancel',
  TASK_GET_QUEUE: 'task:get-queue',
  TASK_GET_PREFLIGHT: 'task:get-preflight',
  TASK_COMPLETE: 'task:complete',
  TASK_PROGRESS: 'task:progress',
  TASK_ERROR: 'task:error',

  AUTOMATION_LIST: 'automation:list',
  AUTOMATION_GET: 'automation:get',
  AUTOMATION_CREATE: 'automation:create',
  AUTOMATION_UPDATE: 'automation:update',
  AUTOMATION_DELETE: 'automation:delete',
  AUTOMATION_RUN_NOW: 'automation:run-now',
  AUTOMATION_CANCEL_PENDING: 'automation:cancel-pending',
  AUTOMATION_LIST_RUNS: 'automation:list-runs',
  AUTOMATION_MARK_SEEN: 'automation:mark-seen',

  AUTOMATION_CHANGED: 'automation:changed',
  AUTOMATION_RUN_CHANGED: 'automation:run-changed',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
