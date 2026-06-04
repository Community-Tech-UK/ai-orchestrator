/**
 * Per-run loop artifact paths.
 *
 * Loop state files (STAGE.md, NOTES.md, ITERATION_LOG.md, LOOP_TASKS.md,
 * DONE.txt, BLOCKED.md) used to live at the **workspace root**. That made two
 * loops in the same workspace (started from different chats — the
 * one-loop-per-chat guard does not stop this) clobber each other's stage,
 * ledger, and done-sentinel, and let a brand-new run inherit a prior run's
 * root LOOP_TASKS.md.
 *
 * The loop *control plane* (`.aio-loop-control/<runId>/`) and *attachments*
 * (`.aio-loop-attachments/<runId>/`) are already per-run scoped and
 * deterministically re-derivable from `(workspaceCwd, loopRunId)` for recovery.
 * This module extends the same pattern to the **state files**, under
 * `<workspaceCwd>/.aio-loop-state/<loopRunId>/`.
 *
 * Pure (path math only, no I/O) so it's trivially unit-tested and shared
 * verbatim by the stage machine, the completion detector, and the coordinator —
 * the agent prompt is handed the same `relDir` so every reader/writer agrees.
 *
 * NOT scoped here (deliberately): the user's `planFile` and the
 * `*_completed.md` rename gate stay workspace-relative — those are user docs,
 * not loop-owned scaffolding.
 */

import * as path from 'node:path';

/** Hidden per-workspace root that holds one subdirectory per loop run. */
export const LOOP_STATE_DIR_NAME = '.aio-loop-state';

export interface LoopArtifactPaths {
  /** Absolute path to the per-run state directory. */
  dir: string;
  /**
   * Workspace-relative POSIX path to the state dir (e.g.
   * `.aio-loop-state/loop-123-abcd`). Injected into the agent prompt so the
   * agent reads/writes the same files the backend reads — the agent runs with
   * cwd = workspaceCwd, so this relative path resolves correctly.
   */
  relDir: string;
  /** Absolute path to STAGE.md inside the state dir. */
  stage: string;
  /** Absolute path to NOTES.md inside the state dir. */
  notes: string;
  /** Absolute path to ITERATION_LOG.md inside the state dir. */
  iterationLog: string;
  /** Absolute path to LOOP_TASKS.md inside the state dir. */
  tasks: string;
  /** Absolute path to the archived prior-run ledger inside the state dir. */
  tasksArchive: string;
  /** Absolute path to BLOCKED.md inside the state dir. */
  blocked: string;
  /**
   * Absolute path to OUTSTANDING.md inside the state dir. review-driven mode:
   * the agent maintains this with items it could NOT resolve autonomously
   * (NEEDS-HUMAN) and open questions; the coordinator reads it on convergence
   * to decide `completed` vs `completed-needs-review`.
   */
  outstanding: string;
}

/**
 * Resolve the per-run artifact paths for a loop. Deterministic: the same
 * `(workspaceCwd, loopRunId)` always yields the same paths, so recovery after
 * a restart re-derives the identical directory.
 */
export function resolveLoopArtifactPaths(workspaceCwd: string, loopRunId: string): LoopArtifactPaths {
  const dir = path.join(path.resolve(workspaceCwd), LOOP_STATE_DIR_NAME, loopRunId);
  return {
    dir,
    relDir: `${LOOP_STATE_DIR_NAME}/${loopRunId}`,
    stage: path.join(dir, 'STAGE.md'),
    notes: path.join(dir, 'NOTES.md'),
    iterationLog: path.join(dir, 'ITERATION_LOG.md'),
    tasks: path.join(dir, 'LOOP_TASKS.md'),
    tasksArchive: path.join(dir, 'LOOP_TASKS.prev.md'),
    blocked: path.join(dir, 'BLOCKED.md'),
    outstanding: path.join(dir, 'OUTSTANDING.md'),
  };
}

/**
 * Absolute path to a configurable-named file inside the state dir (e.g. the
 * `doneSentinelFile`, which defaults to `DONE.txt` but can be reconfigured).
 */
export function loopStateFile(paths: LoopArtifactPaths, name: string): string {
  return path.join(paths.dir, name);
}

/**
 * Workspace-relative POSIX path to a state file, for prompt injection
 * (e.g. `.aio-loop-state/<runId>/DONE.txt`).
 */
export function loopStateRelFile(paths: LoopArtifactPaths, name: string): string {
  return `${paths.relDir}/${name}`;
}
