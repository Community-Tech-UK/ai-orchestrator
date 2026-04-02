/**
 * Core Module
 *
 * Central infrastructure components for error recovery,
 * retry logic, circuit breakers, and system health.
 */

// Error Recovery
export { ErrorRecoveryManager, getErrorRecoveryManager, retryWithBackoff, type WithRetryOptions } from './error-recovery';
export { RetryManager, retryOperation, withRetry, type RetryOptions, type RetryResult } from './retry-manager';

// Circuit Breaker
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitState,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  type CircuitBreakerEvent,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from './circuit-breaker';

// Startup & Migration
export { StartupOptimizer, type StartupTask, type StartupPhase, type TaskResult } from './startup-optimizer';
export { MigrationManager, type Migration, type MigrationResult } from './migration-manager';

// Re-export from subdirectories
export * from './config';
export * from './system';
