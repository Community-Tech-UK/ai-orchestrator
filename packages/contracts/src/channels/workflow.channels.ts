/**
 * IPC channels for workflow transition previews and natural-language suggestions.
 */
export const WORKFLOW_CHANNELS = {
  WORKFLOW_CAN_TRANSITION: 'workflow:can-transition',
  WORKFLOW_NL_SUGGEST: 'workflow:nl-suggest',
} as const;
