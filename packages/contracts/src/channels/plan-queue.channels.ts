/**
 * IPC channels for the Plan Queue panel.
 */
export const PLAN_QUEUE_CHANNELS = {
  // Queries (renderer → main)
  /** Recent runs with their items. */
  PLAN_QUEUE_LIST: 'plan-queue:list',
  /** One run with its items. */
  PLAN_QUEUE_GET: 'plan-queue:get',
  /** Re-run the worktree reconciler and return its alerts. */
  PLAN_QUEUE_ALERTS: 'plan-queue:alerts',
  /** `git diff --shortstat` of a parked item's branch against the run's base. */
  PLAN_QUEUE_DIFFSTAT: 'plan-queue:diffstat',
  /** Read-only discovery counts before starting a run. */
  PLAN_QUEUE_PREVIEW: 'plan-queue:preview',

  // Commands (renderer → main)
  /** Start a run with a chosen session as its parent. */
  PLAN_QUEUE_START: 'plan-queue:start',
  /** Start, or return, the agent that sorts out one folder's set-aside jobs. */
  PLAN_QUEUE_START_SET_ASIDE_AGENT: 'plan-queue:start-set-aside-agent',
  /** Answer an item's question (radio choice in the panel). */
  PLAN_QUEUE_ANSWER: 'plan-queue:answer',
  /** Pause / resume / cancel a run; skip / resume / land-anyway / discard an item. */
  PLAN_QUEUE_CONTROL: 'plan-queue:control',

  // Events (main → renderer)
  /** A run or item changed; carries the run's full DTO. */
  PLAN_QUEUE_STATE_CHANGED: 'plan-queue:state-changed',
} as const;
