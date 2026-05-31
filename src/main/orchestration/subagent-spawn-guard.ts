/**
 * Subagent spawn guard (claude2_todo #18b — "SubagentDepthTracker").
 *
 * A pure, dependency-free decision function that decides whether a parent agent
 * may spawn another child agent. It enforces two structural rails that prevent
 * "agent-spawning-agent" fork bombs in the debate / consensus / loop and remote
 * `run_on_node` paths:
 *
 *   1. **Max spawn depth** — a child may not occupy a hierarchy depth deeper
 *      than `limits.maxDepth`. (0 = unbounded.)
 *   2. **Max concurrent children** — the number of currently-active spawned
 *      children may not exceed `limits.maxConcurrentChildren`. (0/undefined =
 *      unbounded; callers that don't track a live count simply omit it.)
 *
 * Kept pure (no imports, no I/O) so it is trivially unit-testable and can be
 * reused from both the local orchestration spawn path
 * (`instance-orchestration.ts`) and the remote MCP spawn path
 * (`run_on_node` in `initialization-steps.ts`).
 *
 * The toolset-intersection / per-role allowlist half of claude2_todo #18 is
 * intentionally **not** implemented here: it depends on the toolset registry
 * (#19) that does not yet exist. This module is only the recursion/concurrency
 * rail.
 */

/** Default ceiling on how deep a spawned hierarchy may go (0-based: a child of
 *  a root is depth 1). Chosen to allow lead → worker → sub-worker while still
 *  cutting off runaway recursion. */
export const DEFAULT_MAX_SPAWN_DEPTH = 3;

export interface SpawnGuardLimits {
  /**
   * Maximum hierarchy depth a spawned child may occupy (the child's depth is
   * `parentDepth + 1`). `0` (or any non-positive value) disables the cap.
   */
  maxDepth: number;
  /**
   * Global ceiling on concurrently-active spawned children. `0`/`undefined`
   * disables the cap. Only enforced when `activeChildCount` is supplied.
   */
  maxConcurrentChildren?: number;
}

export interface SpawnGuardInput {
  /** Depth of the spawning parent (0 = a top-level/root agent). */
  parentDepth: number;
  /**
   * Count of currently-active spawned children across the relevant scope.
   * Omit when the caller doesn't track a live count (then the concurrency
   * rail is skipped).
   */
  activeChildCount?: number;
  limits: SpawnGuardLimits;
}

export interface SpawnGuardDecision {
  /** Whether the spawn is permitted. */
  allowed: boolean;
  /** The depth the child would occupy (`parentDepth + 1`, clamped to ≥ 1). */
  childDepth: number;
  /** Human-readable explanation when `allowed` is false. */
  reason?: string;
}

/** Normalize a possibly-fractional / negative / non-finite value to a
 *  non-negative integer. */
function toNonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * Decide whether a parent at `parentDepth` may spawn a child, given `limits`.
 *
 * Depth is checked first (the more fundamental rail), then concurrency. The
 * returned `childDepth` is always populated so callers can stamp it onto the
 * spawned instance even when the spawn is allowed.
 */
export function evaluateSpawn(input: SpawnGuardInput): SpawnGuardDecision {
  const parentDepth = toNonNegativeInt(input.parentDepth);
  const childDepth = parentDepth + 1;

  const maxDepth = toNonNegativeInt(input.limits.maxDepth);
  if (maxDepth > 0 && childDepth > maxDepth) {
    return {
      allowed: false,
      childDepth,
      reason: `spawn depth ${childDepth} exceeds the maximum allowed depth of ${maxDepth} (recursion guard)`,
    };
  }

  const maxConcurrent = toNonNegativeInt(input.limits.maxConcurrentChildren);
  if (maxConcurrent > 0 && typeof input.activeChildCount === 'number') {
    const active = toNonNegativeInt(input.activeChildCount);
    if (active >= maxConcurrent) {
      return {
        allowed: false,
        childDepth,
        reason: `active spawned-child count (${active}) has reached the maximum of ${maxConcurrent}`,
      };
    }
  }

  return { allowed: true, childDepth };
}
