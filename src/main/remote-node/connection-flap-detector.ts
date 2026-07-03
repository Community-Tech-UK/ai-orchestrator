/**
 * Sliding-window flap detector for worker-node connections.
 *
 * A flapping node registers → drops → re-registers many times a minute, each
 * cycle evicting the previous socket ("Replacing existing socket"). Silently
 * churning through this hides a real problem. This detector records replace
 * events per node and reports when a node crosses a rate threshold so the
 * coordinator can raise exactly ONE warning per storm (not one per cycle) and
 * surface the flap to the operator.
 *
 * Pure and clock-injected (callers pass `now`) so it is unit-testable without a
 * real `Date.now()`.
 */
export interface FlapRecordResult {
  /** True only on the transition into an active storm (rising edge). */
  readonly stormStarted: boolean;
  /** Number of replace events counted within the sliding window. */
  readonly countInWindow: number;
  /** Whether the node is currently considered in a storm. */
  readonly active: boolean;
}

export class ConnectionFlapDetector {
  private readonly events = new Map<string, number[]>();
  private readonly active = new Set<string>();

  constructor(
    private readonly windowMs: number,
    private readonly threshold: number,
  ) {}

  /**
   * Record a replace/reconnect event for a node at time `now`.
   * Returns whether this crossed into a new storm.
   */
  record(nodeId: string, now: number): FlapRecordResult {
    const prior = (this.events.get(nodeId) ?? []).filter((t) => now - t < this.windowMs);

    // Window emptied since the last event → a prior storm has fully subsided;
    // allow a fresh storm to warn again.
    if (prior.length === 0) {
      this.active.delete(nodeId);
    }

    prior.push(now);
    this.events.set(nodeId, prior);

    const countInWindow = prior.length;
    let stormStarted = false;
    if (countInWindow >= this.threshold && !this.active.has(nodeId)) {
      this.active.add(nodeId);
      stormStarted = true;
    }
    return { stormStarted, countInWindow, active: this.active.has(nodeId) };
  }

  /** Forget a node (e.g. on clean deregistration/server stop). */
  reset(nodeId: string): void {
    this.events.delete(nodeId);
    this.active.delete(nodeId);
  }

  clear(): void {
    this.events.clear();
    this.active.clear();
  }
}
