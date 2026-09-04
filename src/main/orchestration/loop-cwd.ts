import type { LoopConfig } from '../../shared/types/loop.types';

/**
 * A loop has TWO directories and they are not interchangeable.
 *
 * - **state cwd** — `workspaceCwd`, always the repo root. Home of durable
 *   loop-owned state that must outlive the run: `.aio-loop-state/`,
 *   `.aio-loop-control/`, attachments, `BLOCKED.md`, learnings, and the
 *   `repoRoot` the worktree manager prunes against. When isolation is active
 *   the worktree is reaped at the end of the run, so anything written here
 *   must NOT follow it.
 * - **execution cwd** — `executionCwd ?? workspaceCwd`, the directory the agent
 *   actually works in (the per-run worktree under
 *   `isolateLoopWorkspaces`, otherwise the repo root itself). Everything that
 *   *inspects or executes the agent's work product* belongs here: the verify
 *   and quick-verify commands, reviewers, diffs, plan-file rename detection,
 *   and workspace liveness probes.
 *
 * Choosing wrong in the state direction leaks durable state into a directory
 * that gets deleted. Choosing wrong in the execution direction grades code the
 * agent never wrote — which is exactly the defect this module exists to close:
 * before 2026-09-03 the completion gate ran the verify command in the repo
 * root, so under isolation it typechecked other sessions' uncommitted work,
 * failed, and rejected every otherwise-approved completion. No loop reached a
 * clean `completed` status between 2026-06-30 and 2026-09-03.
 *
 * Prefer resolving at the *sink* (the function that finally spawns/reads)
 * rather than at each call site, so a new caller cannot reintroduce the bug.
 * `scripts/check-loop-cwd-discipline.js` enforces that new orchestration code
 * goes through these helpers.
 */

/** Config shape either resolver needs — keeps callers free of the full LoopConfig. */
export type LoopCwdConfig = Pick<LoopConfig, 'workspaceCwd' | 'executionCwd'>;

/**
 * Where the agent's work actually lives: the per-run worktree when isolation is
 * active, otherwise the repo root.
 *
 * Use for: verify / quick-verify spawns, reviewer sessions, `collectWorkspaceDiff`,
 * plan-file rename detection, workspace liveness probes — anything reading or
 * running the work product.
 */
export function loopExecutionCwd(config: LoopCwdConfig): string {
  return config.executionCwd?.trim() || config.workspaceCwd;
}

/**
 * Where durable loop-owned state lives: always the repo root, never the
 * worktree, so state survives the worktree being reaped.
 *
 * Use for: `resolveLoopArtifactPaths`, loop control dir, attachments,
 * `BLOCKED.md`, learnings, worktree `repoRoot`.
 */
export function loopStateCwd(config: LoopCwdConfig): string {
  return config.workspaceCwd;
}

/**
 * True when isolation is actually in force — the agent is working somewhere
 * other than the repo root. Cheaper and clearer at call sites than comparing
 * the two fields inline.
 */
export function isLoopWorkspaceIsolated(config: LoopCwdConfig): boolean {
  const execution = config.executionCwd?.trim();
  return execution !== undefined && execution.length > 0 && execution !== config.workspaceCwd;
}

/**
 * A copy of the config whose `workspaceCwd` is the execution cwd, for the few
 * consumers that take a whole `LoopConfig` and resolve paths from it
 * internally (the preflight is the original example). Prefer passing the
 * resolved string where the callee accepts one.
 */
export function configForLoopExecutionCwd<T extends LoopCwdConfig>(config: T): T {
  const execution = loopExecutionCwd(config);
  if (execution === config.workspaceCwd) return config;
  return { ...config, workspaceCwd: execution };
}
