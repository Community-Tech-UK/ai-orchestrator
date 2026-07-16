/** IPC channels for conversation-scoped context evidence inspection. */
export const CONTEXT_EVIDENCE_CHANNELS = {
  CONTEXT_EVIDENCE_LIST: 'context-evidence:list',
  CONTEXT_EVIDENCE_GET_CARD: 'context-evidence:get-card',
  CONTEXT_EVIDENCE_SEARCH: 'context-evidence:search',
  CONTEXT_EVIDENCE_READ: 'context-evidence:read',
  CONTEXT_EVIDENCE_COMPARE: 'context-evidence:compare',
  CONTEXT_EVIDENCE_VERIFY: 'context-evidence:verify',
  CONTEXT_EVIDENCE_GET_METRICS: 'context-evidence:get-metrics',
  CONTEXT_EVIDENCE_STATE_CHANGED: 'context-evidence:state-changed',
} as const;
