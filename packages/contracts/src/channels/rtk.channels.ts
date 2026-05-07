/**
 * IPC channels for the RTK token-savings panel and related diagnostics.
 *
 * The renderer subscribes to RTK_SAVINGS_DELTA for live updates while a
 * polling service in the main process tails RTK's tracking.db. RTK_GET_*
 * channels are request/response for one-off lookups (e.g. project filtering).
 */
export const RTK_CHANNELS = {
  RTK_GET_SUMMARY: 'rtk:get-summary',
  RTK_GET_HISTORY: 'rtk:get-history',
  RTK_GET_STATUS: 'rtk:get-status',
  RTK_SAVINGS_DELTA: 'rtk:savings-delta',
} as const;
