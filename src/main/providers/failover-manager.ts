/**
 * Failover Manager
 *
 * Manages automatic failover between providers:
 * - Integrates with circuit breakers for health tracking
 * - Automatic provider switching on failures
 * - State preservation during failover
 * - Priority-based provider selection
 */

import { EventEmitter } from 'events';
import { ProviderType, ProviderStatus, ProviderCapabilities } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('FailoverManager');
import { CircuitBreaker, CircuitBreakerRegistry, CircuitState } from '../core/circuit-breaker';
import { ErrorRecoveryManager } from '../core/error-recovery';
import { ClassifiedError, ErrorCategory } from '../../shared/types/error-recovery.types';
import { getProviderRegistry } from './provider-registry';

/**
 * Provider health information
 */
export interface ProviderHealth {
  type: ProviderType;
  status: ProviderStatus;
  circuitState: CircuitState;
  lastCheck: Date;
  failureCount: number;
  latencyMs?: number;
  priority: number;
  available: boolean;
}

/**
 * Failover configuration
 */
export interface FailoverConfig {
  /** Ordered list of providers by preference */
  providerPriority: ProviderType[];
  /** Whether to automatically fail over on errors */
  autoFailover: boolean;
  /** Error categories that trigger failover */
  failoverOn: ErrorCategory[];
  /** Maximum providers to try before giving up */
  maxProviderAttempts: number;
  /** Time to wait before retrying failed provider (ms) */
  providerCooldownMs: number;
  /** Whether to preserve conversation state during failover */
  preserveState: boolean;
  /** Health check interval (ms) */
  healthCheckIntervalMs: number;
}

/**
 * Default failover configuration
 */
export const DEFAULT_FAILOVER_CONFIG: FailoverConfig = {
  providerPriority: ['claude-cli', 'openai', 'google'],
  autoFailover: true,
  failoverOn: [
    ErrorCategory.RATE_LIMITED,
    ErrorCategory.NETWORK,
    ErrorCategory.TRANSIENT,
    ErrorCategory.RESOURCE,
  ],
  maxProviderAttempts: 3,
  providerCooldownMs: 60000, // 1 minute
  preserveState: true,
  healthCheckIntervalMs: 30000, // 30 seconds
};

/**
 * Failover state
 */
export interface FailoverState {
  currentProvider: ProviderType;
  originalProvider: ProviderType;
  failoverCount: number;
  lastFailover?: Date;
  failedProviders: Map<ProviderType, Date>;
  inProgress: boolean;
}

/**
 * Failover events
 */
export type FailoverEvent =
  | { type: 'failover_started'; from: ProviderType; to: ProviderType; reason: string }
  | { type: 'failover_completed'; from: ProviderType; to: ProviderType; success: boolean }
  | { type: 'failover_failed'; from: ProviderType; error: Error; attempted: ProviderType[] }
  | { type: 'provider_recovered'; provider: ProviderType }
  | { type: 'health_check'; results: Map<ProviderType, ProviderHealth> };

/**
 * Failover Manager
 *
 * Manages provider failover with circuit breaker integration.
 */
export class FailoverManager extends EventEmitter {
  private static instance: FailoverManager | null = null;

  private config: FailoverConfig;
  private state: FailoverState;
  private circuitRegistry: CircuitBreakerRegistry;
  private errorRecovery: ErrorRecoveryManager;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private providerHealth: Map<ProviderType, ProviderHealth> = new Map();

  private constructor() {
    super();
    this.config = { ...DEFAULT_FAILOVER_CONFIG };
    this.circuitRegistry = CircuitBreakerRegistry.getInstance();
    this.errorRecovery = ErrorRecoveryManager.getInstance();

    this.state = {
      currentProvider: this.config.providerPriority[0] || 'claude-cli',
      originalProvider: this.config.providerPriority[0] || 'claude-cli',
      failoverCount: 0,
      failedProviders: new Map(),
      inProgress: false,
    };

    // Listen for circuit breaker events
    this.setupCircuitBreakerListeners();
  }

  static getInstance(): FailoverManager {
    if (!FailoverManager.instance) {
      FailoverManager.instance = new FailoverManager();
    }
    return FailoverManager.instance;
  }

  /**
   * Configure the failover manager
   */
  configure(config: Partial<FailoverConfig>): void {
    this.config = { ...this.config, ...config };

    // Restart health check if interval changed
    if (this.healthCheckTimer) {
      this.stopHealthCheck();
      this.startHealthCheck();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): FailoverConfig {
    return { ...this.config };
  }

  /**
   * Get current failover state
   */
  getState(): FailoverState {
    return {
      ...this.state,
      failedProviders: new Map(this.state.failedProviders),
    };
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): ProviderType {
    return this.state.currentProvider;
  }

  /**
   * Set the primary provider
   */
  setPrimaryProvider(provider: ProviderType): void {
    this.state.originalProvider = provider;
    if (!this.state.inProgress) {
      this.state.currentProvider = provider;
    }
  }

  /**
   * Start health check monitoring
   */
  startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      this.checkAllProviderHealth().catch((err) => {
        logger.error('Health check failed', err instanceof Error ? err : undefined);
      });
    }, this.config.healthCheckIntervalMs);

    // Initial check
    this.checkAllProviderHealth().catch(() => {});
  }

  /**
   * Stop health check monitoring
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Check health of all configured providers
   */
  async checkAllProviderHealth(): Promise<Map<ProviderType, ProviderHealth>> {
    const registry = getProviderRegistry();
    const results = new Map<ProviderType, ProviderHealth>();

    for (const providerType of this.config.providerPriority) {
      try {
        const status = await registry.checkProviderStatus(providerType);
        const breaker = this.circuitRegistry.getBreaker(`provider-${providerType}`);
        const stats = breaker.getStats();

        const health: ProviderHealth = {
          type: providerType,
          status,
          circuitState: stats.state,
          lastCheck: new Date(),
          failureCount: stats.failureCount,
          priority: this.config.providerPriority.indexOf(providerType),
          available: status.available && stats.state !== CircuitState.OPEN,
        };

        results.set(providerType, health);
        this.providerHealth.set(providerType, health);

        // Check if a previously failed provider has recovered
        if (
          this.state.failedProviders.has(providerType) &&
          health.available
        ) {
          const failedAt = this.state.failedProviders.get(providerType)!;
          if (Date.now() - failedAt.getTime() >= this.config.providerCooldownMs) {
            this.state.failedProviders.delete(providerType);
            this.emitEvent({ type: 'provider_recovered', provider: providerType });
          }
        }
      } catch (error) {
        // Mark provider as unavailable on check failure
        const health: ProviderHealth = {
          type: providerType,
          status: {
            type: providerType,
            available: false,
            authenticated: false,
            error: (error as Error).message,
          },
          circuitState: CircuitState.OPEN,
          lastCheck: new Date(),
          failureCount: 0,
          priority: this.config.providerPriority.indexOf(providerType),
          available: false,
        };
        results.set(providerType, health);
        this.providerHealth.set(providerType, health);
      }
    }

    this.emitEvent({ type: 'health_check', results });
    return results;
  }

  /**
   * Get health of a specific provider
   */
  getProviderHealth(provider: ProviderType): ProviderHealth | undefined {
    return this.providerHealth.get(provider);
  }

  /**
   * Get all provider health information
   */
  getAllProviderHealth(): Map<ProviderType, ProviderHealth> {
    return new Map(this.providerHealth);
  }

  /**
   * Handle an error and potentially trigger failover
   */
  async handleError(
    error: ClassifiedError,
    currentProvider: ProviderType
  ): Promise<ProviderType | null> {
    // Update circuit breaker
    const breaker = this.getProviderCircuit(currentProvider);
    breaker.recordFailure(error.original, 0);

    // Check if we should failover
    if (!this.config.autoFailover) {
      return null;
    }

    if (!this.config.failoverOn.includes(error.category)) {
      return null;
    }

    // Attempt failover
    return this.failover(currentProvider, error.userMessage);
  }

  /**
   * Trigger a failover to the next available provider
   */
  async failover(fromProvider: ProviderType, reason: string): Promise<ProviderType | null> {
    if (this.state.inProgress) {
      return null; // Failover already in progress
    }

    this.state.inProgress = true;
    this.state.failedProviders.set(fromProvider, new Date());

    const attempted: ProviderType[] = [fromProvider];
    let toProvider: ProviderType | null = null;

    try {
      // Find next available provider
      for (let i = 0; i < this.config.maxProviderAttempts; i++) {
        const candidate = this.getNextProvider(attempted);
        if (!candidate) {
          break;
        }

        attempted.push(candidate);

        // Check if this provider is available
        const breaker = this.getProviderCircuit(candidate);
        if (breaker.getState() === CircuitState.OPEN) {
          continue;
        }

        // Check if in cooldown
        const failedAt = this.state.failedProviders.get(candidate);
        if (failedAt && Date.now() - failedAt.getTime() < this.config.providerCooldownMs) {
          continue;
        }

        // Verify provider is available
        const registry = getProviderRegistry();
        const status = await registry.checkProviderStatus(candidate);
        if (!status.available) {
          breaker.recordFailure(new Error('Provider unavailable'), 0);
          continue;
        }

        // Found a viable provider
        toProvider = candidate;
        break;
      }

      if (toProvider) {
        this.emitEvent({
          type: 'failover_started',
          from: fromProvider,
          to: toProvider,
          reason,
        });

        this.state.currentProvider = toProvider;
        this.state.failoverCount++;
        this.state.lastFailover = new Date();

        this.emitEvent({
          type: 'failover_completed',
          from: fromProvider,
          to: toProvider,
          success: true,
        });

        return toProvider;
      } else {
        this.emitEvent({
          type: 'failover_failed',
          from: fromProvider,
          error: new Error('No available providers'),
          attempted,
        });

        return null;
      }
    } finally {
      this.state.inProgress = false;
    }
  }

  /**
   * Get the next provider to try based on priority
   */
  private getNextProvider(excluded: ProviderType[]): ProviderType | null {
    for (const provider of this.config.providerPriority) {
      if (!excluded.includes(provider)) {
        return provider;
      }
    }
    return null;
  }

  /**
   * Reset to original provider
   */
  resetToOriginal(): void {
    this.state.currentProvider = this.state.originalProvider;
    this.state.failoverCount = 0;
    this.state.failedProviders.clear();
  }

  /**
   * Record a successful call to the current provider
   */
  recordSuccess(provider: ProviderType, durationMs: number): void {
    const breaker = this.getProviderCircuit(provider);
    breaker.recordSuccess(durationMs);

    // If this was the original provider and we've recovered, reset failover state
    if (
      provider === this.state.originalProvider &&
      this.state.currentProvider !== this.state.originalProvider
    ) {
      this.state.currentProvider = this.state.originalProvider;
      this.emitEvent({
        type: 'provider_recovered',
        provider: this.state.originalProvider,
      });
    }
  }

  /**
   * Get or create a circuit breaker for a provider
   */
  getProviderCircuit(provider: ProviderType): CircuitBreaker {
    return this.circuitRegistry.getBreaker(`provider-${provider}`);
  }

  /**
   * Execute an operation with automatic failover
   */
  async executeWithFailover<T>(
    operation: (provider: ProviderType) => Promise<T>,
    options?: {
      onFailover?: (from: ProviderType, to: ProviderType) => void;
    }
  ): Promise<T> {
    let lastError: Error | null = null;
    const attempted: ProviderType[] = [];

    for (let i = 0; i < this.config.maxProviderAttempts; i++) {
      const provider = i === 0
        ? this.state.currentProvider
        : this.getNextProvider(attempted) || this.state.currentProvider;

      if (attempted.includes(provider)) {
        break; // No more providers to try
      }

      attempted.push(provider);
      const breaker = this.getProviderCircuit(provider);

      try {
        const startTime = Date.now();
        const result = await breaker.execute(() => operation(provider));
        this.recordSuccess(provider, Date.now() - startTime);
        return result;
      } catch (error) {
        lastError = error as Error;
        const classifiedError = this.errorRecovery.classifyError(error as Error, `provider-${provider}`);

        // Check if we should failover
        if (this.config.autoFailover && this.config.failoverOn.includes(classifiedError.category)) {
          const nextProvider = this.getNextProvider(attempted);
          if (nextProvider && options?.onFailover) {
            options.onFailover(provider, nextProvider);
          }
          continue;
        }

        // Error not eligible for failover
        throw error;
      }
    }

    // All providers exhausted
    throw lastError || new Error('All providers failed');
  }

  /**
   * Setup circuit breaker event listeners
   */
  private setupCircuitBreakerListeners(): void {
    // Listen for state changes on all provider circuits
    for (const provider of this.config.providerPriority) {
      const breaker = this.getProviderCircuit(provider);
      breaker.on('state_change', (event) => {
        if (event.to === CircuitState.CLOSED && this.state.failedProviders.has(provider)) {
          this.state.failedProviders.delete(provider);
          this.emitEvent({ type: 'provider_recovered', provider });
        }
      });
    }
  }

  /**
   * Emit a typed event
   */
  private emitEvent(event: FailoverEvent): void {
    this.emit(event.type, event);
    this.emit('failover_event', event);
  }

  /**
   * Reset state (for testing)
   */
  reset(): void {
    this.stopHealthCheck();
    this.state = {
      currentProvider: this.config.providerPriority[0] || 'claude-cli',
      originalProvider: this.config.providerPriority[0] || 'claude-cli',
      failoverCount: 0,
      failedProviders: new Map(),
      inProgress: false,
    };
    this.providerHealth.clear();
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopHealthCheck();
    this.reset();
    this.removeAllListeners();
    FailoverManager.instance = null;
  }
}

export default FailoverManager;
