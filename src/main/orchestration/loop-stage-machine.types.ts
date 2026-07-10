/**
 * Types for the loop stage machine. Split out of loop-stage-machine.ts to keep
 * that module focused on behaviour.
 */

/**
 * Workspace snapshot captured by `LoopStageMachine.captureStartupSnapshot`
 * and stored on `LoopState`. Each flag answers "was this artefact already in
 * its 'completed' shape before the agent did any work?" The detector ignores
 * completion signals when the corresponding flag is true so a stale
 * artefact from a prior run can't terminate the loop on iteration 0.
 */
export interface LoopStartupSnapshot {
  /** `config.completion.doneSentinelFile` existed when the snapshot ran. */
  doneSentinelPresent: boolean;
  /** `config.planFile` existed and every `[ ]/[x]` item was already ticked. */
  planChecklistFullyChecked: boolean;
  /**
   * Root-level `.md` files that look like uncompleted planning documents.
   * Excludes:
   *   - files already matching the completion pattern (`*_[Cc]ompleted.md`)
   *   - the well-known project doc denylist (README, CHANGELOG, LICENSE,
   *     AGENTS, CLAUDE, NOTES, STAGE, ITERATION_LOG, DESIGN, DEVELOPMENT, …)
   *
   * Used by the coordinator to auto-enable `requireCompletedFileRename`
   * belt-and-braces when the caller did not explicitly set it. The agent's
   * default prompt already instructs it to rename a fully-implemented plan
   * with `_completed` before stopping; this surface ensures the loop does
   * not accept a bare `DONE.txt` sentinel in workspaces where renames are
   * obviously expected.
   */
  uncompletedPlanFilesAtStart: string[];
  /**
   * LF-4: `LOOP_TASKS.md` existed with ≥1 item and every item was already
   * resolved (done/deferred) at startLoop. Gates the `ledger-complete` signal
   * so a stale, pre-resolved ledger from a prior run is not treated as in-run
   * completion (mirrors `planChecklistFullyChecked`).
   */
  loopTasksLedgerResolvedAtStart: boolean;
}
