export const LOOP_CHANNELS = {
  // Commands (renderer → main)
  LOOP_START: 'loop:start',
  LOOP_PAUSE: 'loop:pause',
  LOOP_RESUME: 'loop:resume',
  LOOP_INTERVENE: 'loop:intervene',
  LOOP_CANCEL: 'loop:cancel',
  LOOP_GET_STATE: 'loop:get-state',
  LOOP_LIST_RUNS_FOR_CHAT: 'loop:list-runs-for-chat',
  LOOP_GET_ITERATIONS: 'loop:get-iterations',

  // Events (main → renderer)
  LOOP_STARTED: 'loop:started',
  LOOP_ITERATION_STARTED: 'loop:iteration-started',
  LOOP_ACTIVITY: 'loop:activity',
  LOOP_ITERATION_COMPLETE: 'loop:iteration-complete',
  LOOP_PAUSED_NO_PROGRESS: 'loop:paused-no-progress',
  LOOP_CLAIMED_DONE_BUT_FAILED: 'loop:claimed-done-but-failed',
  LOOP_INTERVENTION_APPLIED: 'loop:intervention-applied',
  LOOP_COMPLETED: 'loop:completed',
  LOOP_CAP_REACHED: 'loop:cap-reached',
  LOOP_CANCELLED: 'loop:cancelled',
  LOOP_ERROR: 'loop:error',
  LOOP_STATE_CHANGED: 'loop:state-changed',
} as const;
