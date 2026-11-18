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

  /** The Harness connectors at Linear's address, with the saved connection's state. */
  PLAN_QUEUE_LINEAR_LIST: 'plan-queue:linear-list',
  /** Ask who a chosen connector signs in as. Saves nothing. */
  PLAN_QUEUE_LINEAR_IDENTIFY: 'plan-queue:linear-identify',
  /** Linear's teams and their projects, names only, for the folder-link editor. */
  PLAN_QUEUE_LINEAR_PROJECTS: 'plan-queue:linear-projects',
  /** The saved project-to-folder links, each re-checked against its folder on disk. */
  PLAN_QUEUE_LINEAR_LINKS: 'plan-queue:linear-links',

  // Commands (renderer → main)
  /** Start a run with a chosen session as its parent. */
  PLAN_QUEUE_START: 'plan-queue:start',
  /** Start, or return, the agent that sorts out one folder's set-aside jobs. */
  PLAN_QUEUE_START_SET_ASIDE_AGENT: 'plan-queue:start-set-aside-agent',
  /** Live-test copy only: make a disposable repository with a plan and start a run on it. */
  PLAN_QUEUE_LIVETEST_FIXTURE_START: 'plan-queue:livetest-fixture-start',
  /** Live-test copy only: cancel and take away a run made by the fixture start, and its repository. */
  PLAN_QUEUE_LIVETEST_FIXTURE_REMOVE: 'plan-queue:livetest-fixture-remove',
  /** Live-test copy only: the fixtures this copy made, which survive a restart. */
  PLAN_QUEUE_LIVETEST_FIXTURE_LIST: 'plan-queue:livetest-fixture-list',
  /** Answer an item's question (radio choice in the panel). */
  PLAN_QUEUE_ANSWER: 'plan-queue:answer',
  /** Pause / resume / cancel a run; skip / resume / land-anyway / discard an item. */
  PLAN_QUEUE_CONTROL: 'plan-queue:control',

  /** Save the Linear connection once the user id James was shown is confirmed by a second read. */
  PLAN_QUEUE_LINEAR_CONFIRM: 'plan-queue:linear-confirm',
  /** Clear the saved Linear connection. */
  PLAN_QUEUE_LINEAR_FORGET: 'plan-queue:linear-forget',
  /** Check the saved connection now and return its state. */
  PLAN_QUEUE_LINEAR_CHECK: 'plan-queue:linear-check',
  /** Check every row of the whole link list, then save all of it or none of it. */
  PLAN_QUEUE_LINEAR_LINKS_SAVE: 'plan-queue:linear-links-save',
  /** The teams with a linked project or saved rules, with their statuses as Linear lists them and what is offered. */
  PLAN_QUEUE_LINEAR_TEAM_CHOICES: 'plan-queue:linear-team-choices',
  /** Check every saved team against Linear now. */
  PLAN_QUEUE_LINEAR_TEAMS_CHECK: 'plan-queue:linear-teams-check',
  /** Check every row of the whole team list against Linear, then save all of it or none of it. */
  PLAN_QUEUE_LINEAR_TEAMS_SAVE: 'plan-queue:linear-teams-save',

  /** Load the Linear Start preview for a folder: its tickets, built in code from their basic fields. */
  PLAN_QUEUE_LINEAR_PREVIEW_LOAD: 'plan-queue:linear-preview-load',
  /** Load one ticket's description and comments from a Linear preview, with the hash that pins them. */
  PLAN_QUEUE_LINEAR_PREVIEW_TEXT: 'plan-queue:linear-preview-text',

  // Events (main → renderer)
  /** A run or item changed; carries the run's full DTO. */
  PLAN_QUEUE_STATE_CHANGED: 'plan-queue:state-changed',
} as const;
