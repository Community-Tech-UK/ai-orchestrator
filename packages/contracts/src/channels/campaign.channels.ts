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

  // Push events (main → renderer)
  CAMPAIGN_STATE_CHANGED: 'campaign:state-changed',
} as const;
