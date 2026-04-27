/**
 * IPC channels for scheduled automations and their run history.
 */
export const AUTOMATION_CHANNELS = {
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
