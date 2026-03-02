/**
 * Circuit Breaker - Resource protection and restart limits
 *
 * Implements the circuit breaker pattern to prevent cascade failures
 * and protect system resources from runaway restart loops.
 */

import { EventEmitter } from 'events';
import type { CircuitBreakerState, CircuitBreakerStatus } from '../../shared/types/supervision.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('CircuitBreaker');

export interface CircuitBreakerConfig {
  /** Maximum failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before attempting to half-open */
  resetTimeoutMs: number;
  /** Number of successful calls required to close from half-open */
  successThreshold: number;
  /** Maximum restarts per time window */
  maxRestartsPerMinute: number;
  /** Time window for restart rate limiting (ms) */
  rateLimitWindowMs: number;
}

export interface CircuitBreakerMetrics {
  totalFailures: number;
  totalSuccesses: number;
  totalRejects: number;
  currentState: CircuitBreakerStatus;
  lastStateChange: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000, // 30 seconds
  successThreshold: 2,
  maxRestartsPerMinute: 5,
  rateLimitWindowMs: 60000, // 1 minute
};

export class CircuitBreaker extends EventEmitter {
  private state: CircuitBreakerState;
  private config: CircuitBreakerConfig;
  private metrics: CircuitBreakerMetrics;
  private restartTimestamps: number[] = [];
  private halfOpenTimer: NodeJS.Timeout | null = null;
  private readonly id: string;

  constructor(id: string, config: Partial<CircuitBreakerConfig> = {}) {
    super();
    this.id = id;
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    this.state = {
      status: 'closed',
      failureCount: 0,
    };
    this.metrics = {
      totalFailures: 0,
      totalSuccesses: 0,
      totalRejects: 0,
      currentState: 'closed',
      lastStateChange: Date.now(),
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
    };
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    this.state.lastSuccessAt = Date.now();
    this.metrics.totalSuccesses++;
    this.metrics.consecutiveSuccesses++;
    this.metrics.consecutiveFailures = 0;

    if (this.state.status === 'half-open') {
      if (this.metrics.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure(): void {
    this.state.failureCount++;
    this.state.lastFailureAt = Date.now();
    this.metrics.totalFailures++;
    this.metrics.consecutiveFailures++;
    this.metrics.consecutiveSuccesses = 0;

    if (this.state.status === 'half-open') {
      this.transitionTo('open');
    } else if (this.state.status === 'closed') {
      if (this.state.failureCount >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  /**
   * Check if an operation should be allowed
   */
  canExecute(): boolean {
    if (this.state.status === 'closed') {
      return true;
    }

    if (this.state.status === 'open') {
      // Check if enough time has passed to try half-open
      const timeSinceOpen = Date.now() - (this.state.openedAt || 0);
      if (timeSinceOpen >= this.config.resetTimeoutMs) {
        this.transitionTo('half-open');
        return true;
      }
      this.metrics.totalRejects++;
      return false;
    }

    // half-open: allow one request through
    return true;
  }

  /**
   * Check if a restart should be allowed (rate limiting)
   */
  canRestart(): boolean {
    if (!this.canExecute()) {
      return false;
    }

    // Clean up old timestamps
    const now = Date.now();
    const windowStart = now - this.config.rateLimitWindowMs;
    this.restartTimestamps = this.restartTimestamps.filter(t => t > windowStart);

    // Check rate limit
    if (this.restartTimestamps.length >= this.config.maxRestartsPerMinute) {
      logger.warn('Restart rate limit exceeded', { id: this.id, count: this.restartTimestamps.length, max: this.config.maxRestartsPerMinute, windowMs: this.config.rateLimitWindowMs });
      this.emit('rate-limit-exceeded', { id: this.id, count: this.restartTimestamps.length });
      return false;
    }

    return true;
  }

  /**
   * Record a restart attempt
   */
  recordRestart(): void {
    this.restartTimestamps.push(Date.now());
  }

  /**
   * Force the circuit to open
   */
  trip(): void {
    this.transitionTo('open');
  }

  /**
   * Force the circuit to close (reset)
   */
  reset(): void {
    this.state.failureCount = 0;
    this.metrics.consecutiveFailures = 0;
    this.metrics.consecutiveSuccesses = 0;
    this.restartTimestamps = [];
    this.transitionTo('closed');
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Get metrics
   */
  getMetrics(): CircuitBreakerMetrics {
    return { ...this.metrics, currentState: this.state.status };
  }

  /**
   * Get current status
   */
  getStatus(): CircuitBreakerStatus {
    return this.state.status;
  }

  private transitionTo(newStatus: CircuitBreakerStatus): void {
    if (this.state.status === newStatus) return;

    const previousStatus = this.state.status;
    this.state.status = newStatus;
    this.metrics.currentState = newStatus;
    this.metrics.lastStateChange = Date.now();

    if (this.halfOpenTimer) {
      clearTimeout(this.halfOpenTimer);
      this.halfOpenTimer = null;
    }

    switch (newStatus) {
      case 'open':
        this.state.openedAt = Date.now();
        // Schedule transition to half-open
        this.halfOpenTimer = setTimeout(() => {
          if (this.state.status === 'open') {
            this.transitionTo('half-open');
          }
        }, this.config.resetTimeoutMs);
        break;

      case 'closed':
        this.state.failureCount = 0;
        this.state.openedAt = undefined;
        this.metrics.consecutiveFailures = 0;
        break;

      case 'half-open':
        this.metrics.consecutiveSuccesses = 0;
        break;
    }

    logger.info('State transition', { id: this.id, previousStatus, newStatus });
    this.emit('state-change', {
      id: this.id,
      previousStatus,
      newStatus,
      metrics: this.getMetrics(),
    });
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.halfOpenTimer) {
      clearTimeout(this.halfOpenTimer);
      this.halfOpenTimer = null;
    }
    this.removeAllListeners();
  }
}

/**
 * Circuit Breaker Registry - Manages circuit breakers for multiple workers
 */
export class CircuitBreakerRegistry extends EventEmitter {
  private static instance: CircuitBreakerRegistry;
  private breakers: Map<string, CircuitBreaker> = new Map();
  private defaultConfig: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG;

  static getInstance(): CircuitBreakerRegistry {
    if (!this.instance) {
      this.instance = new CircuitBreakerRegistry();
    }
    return this.instance;
  }

  private constructor() {
    super();
  }

  /**
   * Configure default settings
   */
  configure(config: Partial<CircuitBreakerConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get or create a circuit breaker for an ID
   */
  getOrCreate(id: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(id);
    if (!breaker) {
      breaker = new CircuitBreaker(id, { ...this.defaultConfig, ...config });
      breaker.on('state-change', (data) => this.emit('state-change', data));
      breaker.on('rate-limit-exceeded', (data) => this.emit('rate-limit-exceeded', data));
      this.breakers.set(id, breaker);
    }
    return breaker;
  }

  /**
   * Get an existing circuit breaker
   */
  get(id: string): CircuitBreaker | undefined {
    return this.breakers.get(id);
  }

  /**
   * Remove a circuit breaker
   */
  remove(id: string): boolean {
    const breaker = this.breakers.get(id);
    if (breaker) {
      breaker.destroy();
      this.breakers.delete(id);
      return true;
    }
    return false;
  }

  /**
   * Get all circuit breaker states
   */
  getAllStates(): Map<string, CircuitBreakerState> {
    const states = new Map<string, CircuitBreakerState>();
    for (const [id, breaker] of this.breakers) {
      states.set(id, breaker.getState());
    }
    return states;
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, CircuitBreakerMetrics> {
    const metrics = new Map<string, CircuitBreakerMetrics>();
    for (const [id, breaker] of this.breakers) {
      metrics.set(id, breaker.getMetrics());
    }
    return metrics;
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
   * Cleanup
   */
  destroy(): void {
    for (const breaker of this.breakers.values()) {
      breaker.destroy();
    }
    this.breakers.clear();
  }
}

// Export singleton getter
export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  return CircuitBreakerRegistry.getInstance();
}
