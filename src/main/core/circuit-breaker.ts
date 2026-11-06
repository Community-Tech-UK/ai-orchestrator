/**
 * Circuit Breaker
 *
 * Implements the circuit breaker pattern for provider failover:
 * - States: Closed (healthy) → Open (failing) → Half-Open (testing)
 * - Automatic state transitions based on failure/success patterns
 * - Configurable thresholds and timeouts
 */

import { EventEmitter } from 'events';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  /** Normal operation, all requests pass through */
  CLOSED = 'closed',
  /** Too many failures, requests are rejected */
  OPEN = 'open',
  /** Testing if service has recovered */
  HALF_OPEN = 'half_open',
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Number of successes in half-open to close circuit */
  successThreshold: number;
  /** Time to wait before transitioning from open to half-open (ms) */
  resetTimeoutMs: number;
  /** Time window for counting failures (ms) */
  failureWindowMs: number;
  /** Optional timeout for individual calls (ms) */
  callTimeoutMs?: number;
  /** Whether to track slow calls as failures */
  trackSlowCalls: boolean;
  /** Threshold for slow call (ms) */
  slowCallThresholdMs: number;
  /** Percentage of slow calls to trigger open (0-100) */
  slowCallRateThreshold: number;
  /** Minimum number of calls before evaluating thresholds */
  minimumCalls: number;
  /** Errors that say nothing about the provider's health, such as a deliberate stop. */
  ignoreError?: (error: unknown) => boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  resetTimeoutMs: 30000, // 30 seconds
  failureWindowMs: 60000, // 1 minute
  callTimeoutMs: undefined, // No timeout by default
  trackSlowCalls: true,
  slowCallThresholdMs: 10000, // 10 seconds
  slowCallRateThreshold: 50, // 50% slow calls
  minimumCalls: 5,
};

/**
 * Call result for tracking
 */
interface CallResult {
  timestamp: number;
  success: boolean;
  duration: number;
  error?: Error;
}

/**
 * Circuit breaker statistics
 */
export interface CircuitBreakerStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalCalls: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  lastStateChange: Date;
  slowCallRate: number;
  failureRate: number;
  nextAttemptAt?: Date;
}

/**
 * Circuit breaker events
 */
export type CircuitBreakerEvent =
  | { type: 'state_change'; from: CircuitState; to: CircuitState; reason: string }
  | { type: 'call_success'; duration: number }
  | { type: 'call_failure'; duration: number; error: Error }
  | { type: 'call_rejected'; reason: string }
  | { type: 'slow_call'; duration: number; threshold: number };

/**
 * Circuit Breaker
 *
 * Protects against cascading failures by monitoring call success/failure
 * and temporarily blocking calls when a service is unhealthy.
 */
export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private config: CircuitBreakerConfig;
  private readonly name: string;
  private callHistory: CallResult[] = [];
  private halfOpenSuccesses: number = 0;
  private lastStateChange: Date = new Date();
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(name: string, config?: Partial<CircuitBreakerConfig>) {
    super();
    this.name = name;
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Get the circuit name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Check if circuit allows requests
   */
  isAllowed(): boolean {
    switch (this.state) {
      case CircuitState.CLOSED:
        return true;
      case CircuitState.HALF_OPEN:
        return true; // Allow test requests
      case CircuitState.OPEN:
        return false;
    }
  }

  /**
   * Execute a call through the circuit breaker
   */
  async execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // Check if circuit allows the call
    if (!this.isAllowed()) {
      const error = new Error(`Circuit breaker '${this.name}' is OPEN`);
      this.emitEvent({
        type: 'call_rejected',
        reason: 'Circuit is open',
      });
      throw error;
    }

    const startTime = Date.now();

    try {
      // Execute with optional timeout
      let result: T;
      if (this.config.callTimeoutMs) {
        result = await this.withTimeout(fn(), this.config.callTimeoutMs);
      } else {
        result = await fn();
      }

      signal?.throwIfAborted();
      const duration = Date.now() - startTime;
      this.recordSuccess(duration);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      if (!signal?.aborted && !this.config.ignoreError?.(error)) this.recordFailure(error as Error, duration);
      throw error;
    }
  }

  /**
   * Record a successful call
   */
  recordSuccess(duration: number): void {
    const result: CallResult = {
      timestamp: Date.now(),
      success: true,
      duration,
    };
    this.addToHistory(result);

    // Check for slow call
    if (
      this.config.trackSlowCalls &&
      duration > this.config.slowCallThresholdMs
    ) {
      this.emitEvent({
        type: 'slow_call',
        duration,
        threshold: this.config.slowCallThresholdMs,
      });
    }

    this.emitEvent({ type: 'call_success', duration });

    // State transitions on success
    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED, 'Sufficient successes in half-open');
      }
    }

    // Check if we should close circuit based on recovery
    this.evaluateStateChange();
  }

  /**
   * Record a failed call
   */
  recordFailure(error: Error, duration: number): void {
    const result: CallResult = {
      timestamp: Date.now(),
      success: false,
      duration,
      error,
    };
    this.addToHistory(result);

    this.emitEvent({ type: 'call_failure', duration, error });

    // State transitions on failure
    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open immediately opens the circuit
      this.transitionTo(CircuitState.OPEN, 'Failure during half-open test');
    } else {
      this.evaluateStateChange();
    }
  }

  /**
   * Force the circuit to a specific state (for testing/admin)
   */
  forceState(state: CircuitState, reason: string = 'Manual override'): void {
    this.transitionTo(state, reason);
  }

  /**
   * Reset the circuit breaker
   */
  reset(): void {
    this.callHistory = [];
    this.halfOpenSuccesses = 0;
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.transitionTo(CircuitState.CLOSED, 'Reset');
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    const recentCalls = this.getRecentCalls();
    const failures = recentCalls.filter((c) => !c.success);
    const slowCalls = recentCalls.filter(
      (c) => c.duration > this.config.slowCallThresholdMs
    );

    const lastFailure = failures.length > 0
      ? new Date(failures[failures.length - 1]!.timestamp)
      : undefined;
    const lastSuccess = recentCalls.find((c) => c.success);

    return {
      state: this.state,
      failureCount: failures.length,
      successCount: recentCalls.length - failures.length,
      totalCalls: recentCalls.length,
      lastFailure,
      lastSuccess: lastSuccess ? new Date(lastSuccess.timestamp) : undefined,
      lastStateChange: this.lastStateChange,
      slowCallRate: recentCalls.length > 0
        ? (slowCalls.length / recentCalls.length) * 100
        : 0,
      failureRate: recentCalls.length > 0
        ? (failures.length / recentCalls.length) * 100
        : 0,
      nextAttemptAt: this.state === CircuitState.OPEN && this.resetTimer
        ? new Date(Date.now() + this.config.resetTimeoutMs)
        : undefined,
    };
  }

  /**
   * Get configuration
   */
  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  configure(config: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.callHistory = [];
    this.removeAllListeners();
  }

  // ============ Private Methods ============

  /**
   * Add a call result to history
   */
  private addToHistory(result: CallResult): void {
    this.callHistory.push(result);
    this.pruneHistory();
  }

  /**
   * Remove old entries from history
   */
  private pruneHistory(): void {
    const cutoff = Date.now() - this.config.failureWindowMs;
    this.callHistory = this.callHistory.filter((r) => r.timestamp >= cutoff);
  }

  /**
   * Get calls within the failure window
   */
  private getRecentCalls(): CallResult[] {
    const cutoff = Date.now() - this.config.failureWindowMs;
    return this.callHistory.filter((r) => r.timestamp >= cutoff);
  }

  /**
   * Evaluate if state should change based on current metrics
   */
  private evaluateStateChange(): void {
    const recentCalls = this.getRecentCalls();

    // Need minimum calls before evaluating
    if (recentCalls.length < this.config.minimumCalls) {
      return;
    }

    const failures = recentCalls.filter((c) => !c.success).length;
    const slowCalls = recentCalls.filter(
      (c) => c.duration > this.config.slowCallThresholdMs
    ).length;
    const slowCallRate = (slowCalls / recentCalls.length) * 100;

    if (this.state === CircuitState.CLOSED) {
      // Check if we should open
      if (failures >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN, `Failure threshold reached (${failures}/${this.config.failureThreshold})`);
      } else if (
        this.config.trackSlowCalls &&
        slowCallRate >= this.config.slowCallRateThreshold
      ) {
        this.transitionTo(CircuitState.OPEN, `Slow call rate threshold reached (${slowCallRate.toFixed(1)}%)`);
      }
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    if (this.state === newState) return;

    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = new Date();

    // Clear reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    // Handle state-specific logic
    switch (newState) {
      case CircuitState.OPEN:
        // Schedule transition to half-open
        this.resetTimer = setTimeout(() => {
          this.transitionTo(CircuitState.HALF_OPEN, 'Reset timeout elapsed');
        }, this.config.resetTimeoutMs);
        break;

      case CircuitState.HALF_OPEN:
        this.halfOpenSuccesses = 0;
        break;

      case CircuitState.CLOSED:
        this.halfOpenSuccesses = 0;
        break;
    }

    this.emitEvent({
      type: 'state_change',
      from: oldState,
      to: newState,
      reason,
    });
  }

  /**
   * Execute with timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Call timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  /**
   * Emit a typed event
   */
  private emitEvent(event: CircuitBreakerEvent): void {
    this.emit(event.type, event);
    this.emit('circuit_event', { circuit: this.name, ...event });
  }
}

/**
 * Circuit Breaker Registry
 *
 * Manages multiple circuit breakers for different services.
 */
export class CircuitBreakerRegistry {
  private static instance: CircuitBreakerRegistry | null = null;
  private breakers: Map<string, CircuitBreaker> = new Map();
  private defaultConfig: Partial<CircuitBreakerConfig> = {};

  private constructor() {}

  static getInstance(): CircuitBreakerRegistry {
    if (!CircuitBreakerRegistry.instance) {
      CircuitBreakerRegistry.instance = new CircuitBreakerRegistry();
    }
    return CircuitBreakerRegistry.instance;
  }

  static _resetForTesting(): void {
    CircuitBreakerRegistry.instance = null;
  }

  /**
   * Set default configuration for new circuit breakers
   */
  setDefaultConfig(config: Partial<CircuitBreakerConfig>): void {
    this.defaultConfig = config;
  }

  /**
   * Get or create a circuit breaker
   */
  getBreaker(name: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, { ...this.defaultConfig, ...config });
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  /**
   * Get all circuit breakers
   */
  getAllBreakers(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Get stats for all circuit breakers
   */
  getAllStats(): Map<string, CircuitBreakerStats> {
    const stats = new Map<string, CircuitBreakerStats>();
    for (const [name, breaker] of this.breakers) {
      stats.set(name, breaker.getStats());
    }
    return stats;
  }

  /**
   * Remove a circuit breaker
   */
  removeBreaker(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (breaker) {
      breaker.destroy();
      this.breakers.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Clean up all resources
   */
  destroy(): void {
    for (const breaker of this.breakers.values()) {
      breaker.destroy();
    }
    this.breakers.clear();
    CircuitBreakerRegistry.instance = null;
  }
}

export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  return CircuitBreakerRegistry.getInstance();
}

export default CircuitBreaker;
