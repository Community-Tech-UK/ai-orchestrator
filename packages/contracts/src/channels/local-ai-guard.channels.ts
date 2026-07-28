/** IPC channels for Local AI Guard setup, operations, and bounded status updates. */
export const LOCAL_AI_GUARD_CHANNELS = {
  LOCAL_AI_GUARD_GET_SNAPSHOT: 'local-ai-guard:get-snapshot',
  LOCAL_AI_GUARD_TARGET_CREATE: 'local-ai-guard:target-create',
  LOCAL_AI_GUARD_TARGET_UPDATE: 'local-ai-guard:target-update',
  LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE: 'local-ai-guard:target-set-lifecycle',
  LOCAL_AI_GUARD_DISCOVER: 'local-ai-guard:discover',
  LOCAL_AI_GUARD_VALIDATE: 'local-ai-guard:validate',
  LOCAL_AI_GUARD_RECHECK: 'local-ai-guard:recheck',
  LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE: 'local-ai-guard:incident-acknowledge',
  LOCAL_AI_GUARD_DIAGNOSE: 'local-ai-guard:diagnose',
  LOCAL_AI_GUARD_REPAIR: 'local-ai-guard:repair',
  LOCAL_AI_GUARD_SUMMARY_QUERY: 'local-ai-guard:summary-query',
  LOCAL_AI_GUARD_PENDING_FALLBACK_LIST: 'local-ai-guard:pending-fallback-list',
  LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE: 'local-ai-guard:pending-fallback-resolve',
  LOCAL_AI_GUARD_STATUS_DELTA: 'local-ai-guard:status-delta',
} as const;
