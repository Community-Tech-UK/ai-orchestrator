export const LOOP_CHANNELS = {
  // Commands (renderer → main)
  LOOP_START: 'loop:start',
  LOOP_PAUSE: 'loop:pause',
  LOOP_RESUME: 'loop:resume',
  LOOP_INTERVENE: 'loop:intervene',
  LOOP_CANCEL: 'loop:cancel',
  /** LF-7: operator accepts a paused-but-done run (manual-review or pending
   *  complete intent). Runs verify if configured; lands completed /
   *  completed-needs-review. */
  LOOP_ACCEPT_COMPLETION: 'loop:accept-completion',
  LOOP_GET_STATE: 'loop:get-state',
  LOOP_LIST_RUNS_FOR_CHAT: 'loop:list-runs-for-chat',
  /** Bounded, newest-first list of recent loop runs across all chats. Powers
   *  the Workboard's global recovery of active/recently-terminal loop items. */
  LOOP_LIST_RUNS: 'loop:list-runs',
  LOOP_GET_ITERATIONS: 'loop:get-iterations',
  /** Read the durable verification execution ledger for one loop or instance. */
  VERIFICATION_RUNS_LIST: 'verification-runs:list',
  /** LF-3a: preview the verify command the loop would auto-infer for a
   *  workspace, so the config panel can show "verify: <inferred>" before start. */
  LOOP_INFER_VERIFY: 'loop:infer-verify',
  /** WS7: read-only plan-scope assessment (single-loop vs campaign). */
  LOOP_ASSESS_SCOPE: 'loop:assess-scope',
  /** Fable WS6: list available loop recipe packs (built-in + user). */
  LOOP_LIST_RECIPES: 'loop:list-recipes',
  /** List outstanding items (Needs human / Open questions) captured from
   *  completed loop runs, optionally scoped to a session and/or workspace. */
  LOOP_LIST_OUTSTANDING: 'loop:list-outstanding',
  /** Set one outstanding item's resolution status (open / resolved / dismissed). */
  LOOP_SET_OUTSTANDING_STATUS: 'loop:set-outstanding-status',
  /** Export open outstanding items to a consolidated OUTSTANDING.md. */
  LOOP_EXPORT_OUTSTANDING: 'loop:export-outstanding',
  /** Start a fresh loop run that applies the human answers recorded on the open
   *  outstanding items (reusing the source run's config). */
  LOOP_RESUME_WITH_ANSWERS: 'loop:resume-with-answers',
  /** Ping-pong operator control: skip the next reviewer round. */
  LOOP_PINGPONG_SKIP_ROUND: 'loop:pingpong-skip-round',
  /** Ping-pong operator control: force the loop into human arbitration. */
  LOOP_PINGPONG_FORCE_ARBITRATION: 'loop:pingpong-force-arbitration',

  // Events (main → renderer)
  LOOP_STARTED: 'loop:started',
  LOOP_ITERATION_STARTED: 'loop:iteration-started',
  LOOP_ACTIVITY: 'loop:activity',
  LOOP_ITERATION_COMPLETE: 'loop:iteration-complete',
  LOOP_PAUSED_NO_PROGRESS: 'loop:paused-no-progress',
  LOOP_CLAIMED_DONE_BUT_FAILED: 'loop:claimed-done-but-failed',
  LOOP_TERMINAL_INTENT_RECORDED: 'loop:terminal-intent-recorded',
  LOOP_TERMINAL_INTENT_REJECTED: 'loop:terminal-intent-rejected',
  LOOP_FRESH_EYES_REVIEW_STARTED: 'loop:fresh-eyes-review-started',
  LOOP_FRESH_EYES_REVIEW_PASSED: 'loop:fresh-eyes-review-passed',
  LOOP_FRESH_EYES_REVIEW_FAILED: 'loop:fresh-eyes-review-failed',
  LOOP_FRESH_EYES_REVIEW_BLOCKED: 'loop:fresh-eyes-review-blocked',
  LOOP_INTERVENTION_APPLIED: 'loop:intervention-applied',
  LOOP_COMPLETED: 'loop:completed',
  /** LF-7: emitted when a loop terminates in the `completed-needs-review` state. */
  LOOP_COMPLETED_NEEDS_REVIEW: 'loop:completed-needs-review',
  /** LF-3: emitted when NOTES.md was curated to bound context. */
  LOOP_NOTES_CURATED: 'loop:notes-curated',
  /** LF-1: emitted when the loop recycled its persistent adapter to a fresh session. */
  LOOP_CONTEXT_COMPACTED: 'loop:context-compacted',
  /** LF-5: emitted with the outcome of a branch-and-select round. */
  LOOP_BRANCH_SELECT: 'loop:branch-select',
  /** LF-4: emitted when a disposable-plan regeneration was injected on stall. */
  LOOP_PLAN_REGENERATED: 'loop:plan-regenerated',
  /** Emitted once at loop start when LOOP_TASKS.md has structurally unclosable
   *  open items (open-ended scope or hardware/manual-gated) — advisory only. */
  LOOP_LEDGER_LINT: 'loop:ledger-lint',
  /** Pi Task 18: a `steer` intervention was downgraded to next-iteration because
   *  the active loop provider cannot accept mid-iteration input. Lets the UI show
   *  the message was queued, never delivered live. */
  LOOP_STEERING_DOWNGRADED: 'loop:steering-downgraded',
  /** Pi Task 18: the loop deferred a would-be completion to run queued
   *  `follow-up` messages first ("run this before you finish"). */
  LOOP_FOLLOW_UP_DRAINED: 'loop:follow-up-drained',
  /** D5: the agent self-declared "more work remaining", vetoing a would-be
   *  completion so the loop continues. */
  LOOP_MORE_WORK_DECLARED: 'loop:more-work-declared',
  LOOP_FAILED: 'loop:failed',
  LOOP_CAP_REACHED: 'loop:cap-reached',
  /** Usage-aware throttling: the active provider hit a usage/rate limit. The
   *  loop either parked (auto-resume at the window reset) or terminated as
   *  `provider-limit` — distinct from `cap-reached` so the UI/operator knows
   *  it was a quota wall, not a stalled task. */
  LOOP_PROVIDER_LIMIT: 'loop:provider-limit',
  LOOP_CANCELLED: 'loop:cancelled',
  LOOP_ERROR: 'loop:error',
  LOOP_STATE_CHANGED: 'loop:state-changed',
  /** Emitted after a terminal loop persists outstanding items, or after an item's
   *  status changes — tells the renderer's Outstanding panel to refresh. */
  LOOP_OUTSTANDING_CHANGED: 'loop:outstanding-changed',
} as const;
