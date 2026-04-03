/**
 * Compaction Coordinator
 *
 * Monitors instance context usage and coordinates automatic compaction.
 *
 * Dual-threshold strategy (inspired by Copilot SDK):
 * - Warning at 75% (notifies renderer)
 * - Background compact at 80% (non-blocking — instance continues working)
 * - Blocking compact at 95% (blocks input until compacted)
 *
 * Circuit breaker: stops retrying after 3 consecutive failures per instance.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { LIMITS } from '../../shared/constants/limits';
import type { ContextUsage } from '../../shared/types/instance.types';
import { TokenBudgetTracker } from './token-budget-tracker';
import { CompactionEpochTracker } from './compaction-epoch';
import { measureAsync } from '../util/slow-operations';

const logger = getLogger('CompactionCoordinator');

export interface CompactionResult {
  success: boolean;
  method: 'native' | 'restart-with-summary';
  blocking: boolean;
  previousUsage?: ContextUsage;
  newUsage?: ContextUsage;
  summary?: string;
  error?: string;
}

export type CompactionStrategy = (instanceId: string) => Promise<boolean>;

/** Circuit breaker state per instance */
interface CircuitBreakerState {
  consecutiveFailures: number;
  lastFailureTime: number;
}

/** Maximum consecutive compaction failures before circuit breaker trips */
const CIRCUIT_BREAKER_MAX_FAILURES = 3;
/** Time after which the circuit breaker resets (5 minutes) */
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;

export class CompactionCoordinator extends EventEmitter {
  // Thresholds (centralized in LIMITS for discoverability)
  private readonly WARNING_THRESHOLD = LIMITS.COMPACTION_WARNING_THRESHOLD;
  private readonly BACKGROUND_THRESHOLD = LIMITS.COMPACTION_BACKGROUND_THRESHOLD;
  private readonly BLOCKING_THRESHOLD = LIMITS.COMPACTION_BLOCKING_THRESHOLD;

  // Track which instances have been warned/compacted to avoid re-triggering
  private warnedInstances = new Set<string>();
  private compactingInstances = new Set<string>();

  /** Instances currently undergoing background (non-blocking) compaction */
  private backgroundCompactingInstances = new Set<string>();

  // Debounce: track last compaction time per instance
  private lastCompactionTime = new Map<string, number>();
  private readonly COMPACTION_COOLDOWN_MS = LIMITS.COMPACTION_COOLDOWN_MS;

  // Dismissed warnings (reset if percentage increases by >5%)
  private dismissedWarnings = new Map<string, number>(); // instanceId -> percentage when dismissed

  // Track latest context usage per instance (for populating CompactionResult)
  private latestUsage = new Map<string, ContextUsage>();

  // Per-instance budget and epoch trackers
  private budgetTrackers = new Map<string, TokenBudgetTracker>();
  private epochTrackers = new Map<string, CompactionEpochTracker>();

  // Circuit breaker per instance
  private circuitBreakers = new Map<string, CircuitBreakerState>();

  // Auto-compact enabled (default true)
  private autoCompactEnabled = true;

  /**
   * Context token threshold above which compaction should be chunked
   * to prevent the compaction request itself from exceeding context limits.
   * Inspired by Claude Code 2.1.83/2.1.85 fixes for /compact on oversized conversations.
   */
  private readonly CHUNKED_COMPACTION_THRESHOLD_TOKENS = 100_000;

  // Strategy callbacks (injected by wiring code)
  private nativeCompactStrategy: CompactionStrategy | null = null;
  private restartCompactStrategy: CompactionStrategy | null = null;

  // Native compaction capability lookup
  private supportsNativeCompactionForInstance: ((instanceId: string) => boolean) | null = null;

  private static instance: CompactionCoordinator | null = null;

  private constructor() {
    super();
  }

  static getInstance(): CompactionCoordinator {
    if (!CompactionCoordinator.instance) {
      CompactionCoordinator.instance = new CompactionCoordinator();
    }
    return CompactionCoordinator.instance;
  }

  static _resetForTesting(): void {
    if (CompactionCoordinator.instance) {
      CompactionCoordinator.instance.removeAllListeners();
      CompactionCoordinator.instance.circuitBreakers.clear();
      CompactionCoordinator.instance.backgroundCompactingInstances.clear();
      CompactionCoordinator.instance = null;
    }
  }

  /**
   * Configure compaction strategies
   */
  configure(options: {
    nativeCompact?: CompactionStrategy;
    restartCompact?: CompactionStrategy;
    supportsNativeCompaction?: (instanceId: string) => boolean;
  }): void {
    if (options.nativeCompact) this.nativeCompactStrategy = options.nativeCompact;
    if (options.restartCompact) this.restartCompactStrategy = options.restartCompact;
    if (options.supportsNativeCompaction) {
      this.supportsNativeCompactionForInstance = options.supportsNativeCompaction;
    }
  }

  /**
   * Set auto-compact enabled/disabled
   */
  setAutoCompact(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
    logger.info('Auto-compact toggled', { enabled });
  }

  /**
   * Called on every contextUsage update (from batch-update events).
   *
   * Dual-threshold compaction (inspired by Copilot SDK):
   * - 75%: Warning (UI notification only)
   * - 80%: Background compaction (non-blocking — instance keeps working)
   * - 95%: Blocking compaction (halts input until context is freed)
   */
  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    this.latestUsage.set(instanceId, usage);
    const percentage = usage.percentage;

    // Check if a dismissed warning should re-appear (usage increased >5% since dismissal)
    const dismissedAt = this.dismissedWarnings.get(instanceId);
    if (dismissedAt !== undefined && percentage > dismissedAt + 5) {
      this.dismissedWarnings.delete(instanceId);
    }

    // Check circuit breaker — skip auto-compaction if tripped
    if (this.isCircuitBreakerTripped(instanceId)) {
      // Still emit warnings for the UI, but don't try to auto-compact
      if (percentage >= this.BLOCKING_THRESHOLD) {
        this.emit('context-warning', { instanceId, percentage, level: 'emergency' as const });
      }
      return;
    }

    // ── BLOCKING threshold (95%+) ──
    // Instance MUST stop and wait for compaction to complete.
    if (percentage >= this.BLOCKING_THRESHOLD) {
      this.emit('context-warning', {
        instanceId,
        percentage,
        level: 'emergency' as const,
      });

      if (this.autoCompactEnabled && !this.compactingInstances.has(instanceId)) {
        void this.triggerBlockingCompact(instanceId, usage);
      }
      return;
    }

    // ── BACKGROUND threshold (80%+) ──
    // Start compaction in the background — instance keeps working.
    if (percentage >= this.BACKGROUND_THRESHOLD) {
      if (!this.dismissedWarnings.has(instanceId)) {
        this.emit('context-warning', {
          instanceId,
          percentage,
          level: 'critical' as const,
        });
      }

      if (
        this.autoCompactEnabled &&
        !this.compactingInstances.has(instanceId) &&
        !this.backgroundCompactingInstances.has(instanceId)
      ) {
        void this.triggerBackgroundCompact(instanceId, usage);
      }
      return;
    }

    // ── WARNING threshold (75%+) ──
    if (percentage >= this.WARNING_THRESHOLD) {
      if (!this.warnedInstances.has(instanceId) && !this.dismissedWarnings.has(instanceId)) {
        this.warnedInstances.add(instanceId);
        this.emit('context-warning', {
          instanceId,
          percentage,
          level: 'warning' as const,
        });
      }
      return;
    }

    // Below warning threshold — clear warnings
    this.warnedInstances.delete(instanceId);
    this.dismissedWarnings.delete(instanceId);
  }

  /**
   * Dismiss a warning for an instance
   */
  dismissWarning(instanceId: string, currentPercentage: number): void {
    this.dismissedWarnings.set(instanceId, currentPercentage);
  }

  /**
   * Manual trigger (from IPC or /compact command)
   */
  async compactInstance(instanceId: string): Promise<CompactionResult> {
    if (this.compactingInstances.has(instanceId)) {
      return { success: false, method: 'native', blocking: true, error: 'Compaction already in progress' };
    }

    return this.executeCompaction(instanceId, true);
  }

  getBudgetTracker(instanceId: string, totalBudget = 200000): TokenBudgetTracker {
    let tracker = this.budgetTrackers.get(instanceId);
    if (!tracker) {
      tracker = new TokenBudgetTracker({ totalBudget });
      this.budgetTrackers.set(instanceId, tracker);
    }
    return tracker;
  }

  getEpochTracker(instanceId: string): CompactionEpochTracker {
    let tracker = this.epochTrackers.get(instanceId);
    if (!tracker) {
      tracker = new CompactionEpochTracker();
      this.epochTrackers.set(instanceId, tracker);
    }
    return tracker;
  }

  /**
   * Clean up tracking for a terminated instance
   */
  cleanupInstance(instanceId: string): void {
    this.warnedInstances.delete(instanceId);
    this.compactingInstances.delete(instanceId);
    this.backgroundCompactingInstances.delete(instanceId);
    this.lastCompactionTime.delete(instanceId);
    this.dismissedWarnings.delete(instanceId);
    this.latestUsage.delete(instanceId);
    this.budgetTrackers.delete(instanceId);
    this.epochTrackers.delete(instanceId);
    this.circuitBreakers.delete(instanceId);
  }

  /**
   * Check if an instance is currently compacting
   */
  isCompacting(instanceId: string): boolean {
    return this.compactingInstances.has(instanceId);
  }

  /**
   * Background compaction (non-blocking).
   * The instance continues processing while compaction runs.
   * Fires-and-forgets without awaiting — caller is not blocked.
   */
  private async triggerBackgroundCompact(instanceId: string, usage: ContextUsage): Promise<void> {
    // Check cooldown
    const lastTime = this.lastCompactionTime.get(instanceId);
    if (lastTime && Date.now() - lastTime < this.COMPACTION_COOLDOWN_MS) {
      logger.debug('Skipping background compact (cooldown)', { instanceId });
      return;
    }

    this.backgroundCompactingInstances.add(instanceId);
    logger.info('Background compact triggered (non-blocking)', {
      instanceId,
      percentage: usage.percentage,
    });

    try {
      const result = await this.executeCompaction(instanceId, false);
      if (!result.success) {
        this.recordCircuitBreakerFailure(instanceId);
        logger.warn('Background compact failed', { instanceId, error: result.error });
      } else {
        this.resetCircuitBreaker(instanceId);
      }
    } finally {
      this.backgroundCompactingInstances.delete(instanceId);
    }
  }

  /**
   * Blocking compaction (emergency).
   * The instance is halted until compaction completes or fails.
   */
  private async triggerBlockingCompact(instanceId: string, usage: ContextUsage): Promise<void> {
    // Check cooldown (shorter for blocking — urgency is higher)
    const lastTime = this.lastCompactionTime.get(instanceId);
    const blockingCooldown = this.COMPACTION_COOLDOWN_MS / 2; // 15s for emergencies
    if (lastTime && Date.now() - lastTime < blockingCooldown) {
      logger.debug('Skipping blocking compact (cooldown)', { instanceId });
      return;
    }

    logger.warn('Blocking compact triggered — instance halted', {
      instanceId,
      percentage: usage.percentage,
    });

    const result = await this.executeCompaction(instanceId, true);

    if (!result.success) {
      this.recordCircuitBreakerFailure(instanceId);
      logger.error('Blocking compact failed — instance may be stuck', new Error(result.error ?? 'unknown'), { instanceId });
    } else {
      this.resetCircuitBreaker(instanceId);
    }
  }

  // ── Circuit Breaker ──

  private isCircuitBreakerTripped(instanceId: string): boolean {
    const state = this.circuitBreakers.get(instanceId);
    if (!state) return false;

    // Reset if enough time has passed since last failure
    if (Date.now() - state.lastFailureTime > CIRCUIT_BREAKER_RESET_MS) {
      this.circuitBreakers.delete(instanceId);
      return false;
    }

    return state.consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES;
  }

  private recordCircuitBreakerFailure(instanceId: string): void {
    const state = this.circuitBreakers.get(instanceId) ?? { consecutiveFailures: 0, lastFailureTime: 0 };
    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();
    this.circuitBreakers.set(instanceId, state);

    if (state.consecutiveFailures >= CIRCUIT_BREAKER_MAX_FAILURES) {
      logger.error('Compaction circuit breaker tripped', new Error('Too many consecutive failures'), {
        instanceId,
        failures: state.consecutiveFailures,
      });
      this.emit('compaction-circuit-breaker-tripped', { instanceId, failures: state.consecutiveFailures });
    }
  }

  private resetCircuitBreaker(instanceId: string): void {
    this.circuitBreakers.delete(instanceId);
  }

  /**
   * Check if this instance needs chunked compaction due to oversized context.
   * Returns true if the current context usage exceeds the chunking threshold.
   */
  needsChunkedCompaction(instanceId: string): boolean {
    const usage = this.latestUsage.get(instanceId);
    if (!usage) return false;
    return usage.used >= this.CHUNKED_COMPACTION_THRESHOLD_TOKENS;
  }

  private async executeCompaction(instanceId: string, blocking = true): Promise<CompactionResult> {
    this.compactingInstances.add(instanceId);
    const previousUsage = this.latestUsage.get(instanceId);
    this.emit('compaction-started', { instanceId });

    // If context is very large, emit a warning for chunked approach
    if (this.needsChunkedCompaction(instanceId)) {
      logger.info('Large context detected — compaction may require multiple passes', {
        instanceId,
        usedTokens: previousUsage?.used,
        threshold: this.CHUNKED_COMPACTION_THRESHOLD_TOKENS,
      });
      this.emit('compaction-chunked-start', {
        instanceId,
        usedTokens: previousUsage?.used,
      });
    }

    try {
      // Determine strategy from adapter capability
      const nativeCompactionSupported = this.supportsNativeCompactionForInstance?.(instanceId) ?? false;

      let success = false;
      let method: 'native' | 'restart-with-summary' = 'native';

      if (nativeCompactionSupported && this.nativeCompactStrategy) {
        // Try native strategy first when provider supports it
        const strategy = this.nativeCompactStrategy;
        success = await measureAsync('context.compact', () => strategy(instanceId));
        method = 'native';
      }

      if (!success && this.restartCompactStrategy) {
        // Fallback to restart-with-summary
        const strategy = this.restartCompactStrategy;
        success = await measureAsync('context.compact', () => strategy(instanceId));
        method = 'restart-with-summary';
      }

      // Always set cooldown to prevent retry loops on failure
      this.lastCompactionTime.set(instanceId, Date.now());

      if (!success) {
        const result: CompactionResult = {
          success: false,
          method,
          blocking,
          previousUsage,
          error: 'No compaction strategy available or all strategies failed',
        };
        this.emit('compaction-completed', { instanceId, result });
        return result;
      }

      this.warnedInstances.delete(instanceId);
      this.dismissedWarnings.delete(instanceId);

      const result: CompactionResult = { success: true, method, blocking, previousUsage };
      this.emit('compaction-completed', { instanceId, result });

      // Emit PostCompact hook event for downstream processing
      // (logging, RLM metrics, memory persistence, etc.)
      this.emit('post-compact-hook', {
        instanceId,
        method,
        success: true,
        previousUsagePercent: previousUsage?.percentage,
      });

      logger.info('Compaction completed', { instanceId, method });
      return result;
    } catch (error) {
      // Set cooldown even on error to prevent retry loops
      this.lastCompactionTime.set(instanceId, Date.now());
      const result: CompactionResult = {
        success: false,
        method: 'native',
        blocking,
        previousUsage,
        error: (error as Error).message,
      };
      this.emit('compaction-error', { instanceId, error: (error as Error).message });
      logger.error('Compaction failed', error as Error, { instanceId });
      return result;
    } finally {
      this.compactingInstances.delete(instanceId);
    }
  }
}

// Convenience getter
export function getCompactionCoordinator(): CompactionCoordinator {
  return CompactionCoordinator.getInstance();
}
