/**
 * IPC channels retained for persisted operator run audit/control.
 */
export const OPERATOR_CHANNELS = {
  OPERATOR_LIST_RUNS: 'operator:list-runs',
  OPERATOR_GET_RUN: 'operator:get-run',
  OPERATOR_CANCEL_RUN: 'operator:cancel-run',
  OPERATOR_EVENT: 'operator:event',
} as const;
