/**
 * IPC channels for memory subsystems: process memory stats, Memory-R1,
 * Unified Memory, RLM Context Management, and Observation Memory.
 */
export const MEMORY_CHANNELS = {
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

  // Codebase Mining operations
  CODEBASE_MINE_DIRECTORY: 'codebase:mine-directory',
  CODEBASE_GET_STATUS: 'codebase:get-status',

  // Knowledge event forwarding (main -> renderer)
  KG_EVENT_FACT_ADDED: 'kg:event:fact-added',
  KG_EVENT_FACT_INVALIDATED: 'kg:event:fact-invalidated',
  CONVO_EVENT_IMPORT_COMPLETE: 'convo:event:import-complete',
  WAKE_EVENT_HINT_ADDED: 'wake:event:hint-added',
  WAKE_EVENT_CONTEXT_GENERATED: 'wake:event:context-generated',
} as const;
