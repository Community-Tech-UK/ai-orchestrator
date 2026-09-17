/**
 * Provider-owned background work (background shells, background agents) that
 * outlives the assistant turn that started it. An `idle` session with this set
 * is still waiting on something, so the renderer must not show it as finished.
 * Absent (or `null` in a state update) when there is none.
 */
export interface InstanceBackgroundWork {
  /** Number of live background tasks. */
  count: number;
  /** Epoch ms when the oldest live task started. */
  since: number;
}
