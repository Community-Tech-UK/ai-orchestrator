/**
 * Init/wake/respawn wait budget for InstanceManager.sendInput().
 *
 * sendInput() holds a queued message until a background init/wake/respawn
 * finishes. A FIXED 30s cap here used to drop messages whenever a large-context
 * session had to be restarted: on native-resume failure the runtime replays the
 * full transcript into a fresh CLI process, and that replay scales with context
 * size — a ~200k-token session cannot reach input-readiness in 30s, so the
 * message was retried and dropped ("Failed to send message after N retries:
 * Instance initialization timed out").
 *
 * The budget is scaled the way the stream-idle/stuck watchdogs already scale
 * theirs (by host load), plus by the transcript size that must be replayed,
 * and clamped so a genuinely wedged init is still bounded.
 *
 * Electron/DI-free so it is trivially unit-testable and importable anywhere.
 */

/** Base budget when there is little/no transcript to replay and the host is calm. */
export const INIT_WAIT_BASE_MS = 30_000;
/** Tokens replayed for free before the per-token allowance kicks in. */
export const INIT_WAIT_CONTEXT_FREE_TOKENS = 50_000;
/** Extra wait granted per 1k replayable tokens above the free floor. */
export const INIT_WAIT_MS_PER_1K_TOKENS = 500;
/** Hard ceiling so a wedged init cannot hold the send path indefinitely. */
export const INIT_WAIT_MAX_MS = 180_000;

/**
 * Pure budget calculation.
 *
 * @param contextTokens Current context-window occupancy (instance.contextUsage.used).
 * @param loadMultiplier Host-load watchdog multiplier (>= 1); pass 1 when calm.
 */
export function computeInitWaitBudgetMs(contextTokens: number, loadMultiplier: number): number {
  const safeTokens = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : 0;
  const safeMultiplier = Number.isFinite(loadMultiplier) && loadMultiplier >= 1 ? loadMultiplier : 1;
  const replayableTokens = Math.max(0, safeTokens - INIT_WAIT_CONTEXT_FREE_TOKENS);
  const contextMs = (replayableTokens / 1000) * INIT_WAIT_MS_PER_1K_TOKENS;
  const scaled = (INIT_WAIT_BASE_MS + contextMs) * safeMultiplier;
  return Math.min(Math.max(scaled, INIT_WAIT_BASE_MS), INIT_WAIT_MAX_MS);
}
