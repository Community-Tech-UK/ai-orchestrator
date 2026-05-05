/**
 * IPC channels for the global Operator control-plane foundation.
 */
export const OPERATOR_CHANNELS = {
  OPERATOR_GET_THREAD: 'operator:get-thread',
  OPERATOR_SEND_MESSAGE: 'operator:send-message',
  OPERATOR_LIST_PROJECTS: 'operator:list-projects',
  OPERATOR_RESCAN_PROJECTS: 'operator:rescan-projects',
  OPERATOR_LIST_RUNS: 'operator:list-runs',
  OPERATOR_GET_RUN: 'operator:get-run',
} as const;
