/**
 * Action / cost circuit breaker (backlog #28).
 *
 * Cline-style "check in after N actions or $X" safety valve: instead of a single
 * all-or-nothing YOLO switch, the orchestrator can let an agent run autonomously
 * but force a human checkpoint every N approved tool actions and/or after a cost
 * threshold. When a threshold is crossed the breaker "trips", which the tool
 * execution gate turns into an `ask` (approval) decision; the counters then reset
 * so the next checkpoint is another N actions / $X away.
 *
 * Disabled by default (thresholds of 0). In-memory + per-instance, so it adds no
 * behavior until explicitly configured.
 */

export interface CircuitBreakerConfig {
  /** Force a check-in after this many approved actions. 0 disables. */
  maxActions: number;
  /** Force a check-in after this much accumulated cost (USD). 0 disables. */
  maxCostUsd: number;
}

export interface CircuitBreakerTrip {
  tripped: boolean;
  reason?: string;
}

interface InstanceCounters {
  actions: number;
  costUsd: number;
}

const DISABLED: CircuitBreakerConfig = { maxActions: 0, maxCostUsd: 0 };

export class ActionCircuitBreaker {
  private config: CircuitBreakerConfig = { ...DISABLED };
  private readonly counters = new Map<string, InstanceCounters>();

  configure(config: Partial<CircuitBreakerConfig>): void {
    this.config = {
      maxActions: Math.max(0, Math.floor(config.maxActions ?? this.config.maxActions)),
      maxCostUsd: Math.max(0, config.maxCostUsd ?? this.config.maxCostUsd),
    };
  }

  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  get enabled(): boolean {
    return this.config.maxActions > 0 || this.config.maxCostUsd > 0;
  }

  private counter(instanceId: string): InstanceCounters {
    let c = this.counters.get(instanceId);
    if (!c) {
      c = { actions: 0, costUsd: 0 };
      this.counters.set(instanceId, c);
    }
    return c;
  }

  /** Record an approved action. Returns whether a check-in is now required. */
  recordAction(instanceId: string): CircuitBreakerTrip {
    if (!this.enabled) return { tripped: false };
    const c = this.counter(instanceId);
    c.actions += 1;
    return this.evaluate(instanceId);
  }

  /**
   * Accumulate cost for an instance (e.g. from a usage/turn-completed event).
   * This only accumulates — the threshold is enforced at the action gate
   * (recordAction/evaluate) so a cost checkpoint surfaces as an `ask` on the next
   * tool action rather than being swallowed by an immediate reset.
   */
  recordCost(instanceId: string, costUsd: number): void {
    if (!this.enabled || !(costUsd > 0)) return;
    this.counter(instanceId).costUsd += costUsd;
  }

  /** Check current state without mutating counters. */
  evaluate(instanceId: string): CircuitBreakerTrip {
    if (!this.enabled) return { tripped: false };
    const c = this.counters.get(instanceId);
    if (!c) return { tripped: false };

    const { maxActions, maxCostUsd } = this.config;
    if (maxActions > 0 && c.actions >= maxActions) {
      const reason = `Approval checkpoint: ${c.actions} actions since last check-in (limit ${maxActions})`;
      this.acknowledge(instanceId);
      return { tripped: true, reason };
    }
    if (maxCostUsd > 0 && c.costUsd >= maxCostUsd) {
      const reason = `Approval checkpoint: $${c.costUsd.toFixed(2)} spent since last check-in (limit $${maxCostUsd.toFixed(2)})`;
      this.acknowledge(instanceId);
      return { tripped: true, reason };
    }
    return { tripped: false };
  }

  /** Reset an instance's counters (called when a checkpoint is acknowledged). */
  acknowledge(instanceId: string): void {
    this.counters.set(instanceId, { actions: 0, costUsd: 0 });
  }

  /** Forget an instance entirely (e.g. on termination). */
  reset(instanceId: string): void {
    this.counters.delete(instanceId);
  }

  resetAll(): void {
    this.counters.clear();
  }
}

let singleton: ActionCircuitBreaker | null = null;

export function getActionCircuitBreaker(): ActionCircuitBreaker {
  singleton ??= new ActionCircuitBreaker();
  return singleton;
}

export function _resetActionCircuitBreakerForTesting(): void {
  singleton = null;
}
