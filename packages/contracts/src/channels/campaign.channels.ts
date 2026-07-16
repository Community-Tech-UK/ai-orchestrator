/**
 * IPC channels for Campaign Mode (DAG of loop specs).
 */
export const CAMPAIGN_CHANNELS = {
  // Request/response
  CAMPAIGN_START: 'campaign:start',
  CAMPAIGN_GET: 'campaign:get',
  CAMPAIGN_LIST: 'campaign:list',
  CAMPAIGN_HALT: 'campaign:halt',
  CAMPAIGN_RESUME: 'campaign:resume',
  CAMPAIGN_VALIDATE: 'campaign:validate',
  /** WS8: build a preview campaign from a configured repository plan. */
  CAMPAIGN_IMPORT_PLAN_PREVIEW: 'campaign:import-plan-preview',

  // Push events (main → renderer)
  CAMPAIGN_STATE_CHANGED: 'campaign:state-changed',
} as const;
