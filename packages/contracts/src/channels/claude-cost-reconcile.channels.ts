/**
 * IPC channels for the daily Claude cost check shown on the Costs page.
 *
 * Neither channel carries a payload: GET returns the stored snapshot, RUN starts
 * a check now (sharing one that is already running) and returns the snapshot.
 */
export const CLAUDE_COST_RECONCILE_CHANNELS = {
  CLAUDE_COST_RECONCILE_GET: 'claude-cost-reconcile:get',
  CLAUDE_COST_RECONCILE_RUN: 'claude-cost-reconcile:run',
} as const;
