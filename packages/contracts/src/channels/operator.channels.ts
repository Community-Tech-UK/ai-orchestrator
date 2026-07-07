/**
 * IPC channels retained for persisted operator run audit/control.
 */
export const OPERATOR_CHANNELS = {
  OPERATOR_LIST_RUNS: 'operator:list-runs',
  OPERATOR_GET_RUN: 'operator:get-run',
  OPERATOR_CANCEL_RUN: 'operator:cancel-run',
  OPERATOR_LIST_PROJECTS: 'operator:list-projects',
  OPERATOR_RESCAN_PROJECTS: 'operator:rescan-projects',
  OPERATOR_RESOLVE_PROJECT: 'operator:resolve-project',
  OPERATOR_PLAN_PROJECT_VERIFICATION: 'operator:plan-project-verification',
  OPERATOR_EVENT: 'operator:event',
} as const;
