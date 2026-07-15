/**
 * Compaction Coordinator
 *
 * Monitors instance context usage and coordinates automatic compaction.
 *
 * The provider-neutral ContextSafetyPolicy owns automatic pressure decisions.
 * Legacy 75/80/95 warning events remain as deprecated renderer compatibility.
 *
 * Circuit breaker: stops retrying after 3 consecutive failures per instance.
 */

import { EventEmitter } from 'events';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import { getLogger } from '../logging/logger';
import type { ContextUsage } from '../../shared/types/instance.types';
import type { ContextEvidenceMode } from '../../shared/types/settings.types';
import { TokenBudgetTracker } from './token-budget-tracker';
import { CompactionEpochTracker } from './compaction-epoch';
import { measureAsync } from '../util/slow-operations';
import type { ProviderContextActionExecutor } from '../context-evidence/provider-context-action-executor';
import {
  ContextPolicyRuntime,
  type ContextPolicyEvent,
} from './context-policy-runtime';

export type { ContextPolicyEvent } from './context-policy-runtime';

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
  private readonly policyRuntime = new ContextPolicyRuntime((event) => {
    this.emit('context-policy-event', event);
    try {
      const result = this.recordPolicyEventCallback?.(event);
      if (result) void result.catch(() => undefined);
    } catch {
      // Diagnostics must never break context processing.
    }
  });

  // Track which instances have been warned/compacted to avoid re-triggering
  private warnedInstances = new Set<string>();
  private compactingInstances = new Set<string>();

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

  /** @deprecated Shared 2x/4x policy thresholds supersede this setting. */
  private cumulativeTokenTrigger = 0;

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

  /**
   * Lookup that returns true when the adapter handles its own context
   * compaction internally (e.g. Claude CLI auto-compacts at the model's own
   * threshold). When true, `onContextUpdate` will NOT auto-trigger compaction
   * for that instance — the orchestrator defers to the adapter's internal
   * path. Manual `compactInstance()` calls are unaffected; users can still
   * force compaction explicitly.
   */
  private selfManagedAutoCompactionForInstance: ((instanceId: string) => boolean) | null = null;
  private getContextCapabilitiesForInstance:
    ((instanceId: string) => ProviderContextCapabilities | null) | null = null;
  private getContextEvidenceModeForInstance:
    ((instanceId: string) => ContextEvidenceMode) | null = null;
  private getProviderActionExecutorForInstance:
    ((instanceId: string) => ProviderContextActionExecutor | null) | null = null;
  private recordPolicyEventCallback:
    ((event: ContextPolicyEvent) => void | Promise<void>) | null = null;

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
    /**
     * Lookup that returns true when the adapter manages its own internal
     * auto-compaction (e.g. Claude CLI in stream-json mode). When true,
     * `onContextUpdate` will skip auto-triggering compaction for that
     * instance. Manual `compactInstance()` is NOT affected.
     */
    selfManagesAutoCompaction?: (instanceId: string) => boolean;
    getContextCapabilities?: (instanceId: string) => ProviderContextCapabilities | null;
    getContextEvidenceMode?: (instanceId: string) => ContextEvidenceMode;
    getProviderActionExecutor?: (instanceId: string) => ProviderContextActionExecutor | null;
    recordPolicyEvent?: (event: ContextPolicyEvent) => void | Promise<void>;
  }): void {
    if (options.nativeCompact) this.nativeCompactStrategy = options.nativeCompact;
    if (options.restartCompact) this.restartCompactStrategy = options.restartCompact;
    if (options.supportsNativeCompaction) {
      this.supportsNativeCompactionForInstance = options.supportsNativeCompaction;
    }
    if (options.selfManagesAutoCompaction) {
      this.selfManagedAutoCompactionForInstance = options.selfManagesAutoCompaction;
    }
    if (options.getContextCapabilities) {
      this.getContextCapabilitiesForInstance = options.getContextCapabilities;
    }
    if (options.getContextEvidenceMode) {
      this.getContextEvidenceModeForInstance = options.getContextEvidenceMode;
    }
    if (options.getProviderActionExecutor) {
      this.getProviderActionExecutorForInstance = options.getProviderActionExecutor;
    }
    if (options.recordPolicyEvent) this.recordPolicyEventCallback = options.recordPolicyEvent;
  }

  /**
   * Set auto-compact enabled/disabled
   */
  setAutoCompact(enabled: boolean): void {
    this.autoCompactEnabled = enabled;
    logger.info('Auto-compact toggled', { enabled });
  }

  /**
   * Set the cumulative-input-token compaction trigger (claude2_todo #34b).
   * `tokens <= 0` (or non-finite) disables it. Values are floored to integers.
   */
  setCumulativeTokenTrigger(tokens: number): void {
    const next = typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
      ? Math.floor(tokens)
      : 0;
    if (next !== this.cumulativeTokenTrigger) {
      this.cumulativeTokenTrigger = next;
      logger.info('Cumulative-token compaction trigger set', {
        threshold: next === 0 ? 'disabled' : next,
      });
    }
  }

  /** Current cumulative-token trigger (0 = disabled). Exposed for tests/telemetry. */
  getCumulativeTokenTrigger(): number {
    return this.cumulativeTokenTrigger;
  }

  /** Records the sample synchronously, then serializes shared-policy decisions per instance. */
  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    this.latestUsage.set(instanceId, usage);
    this.emitLegacyWarning(instanceId, usage.percentage);

    const capabilities = this.getContextCapabilitiesForInstance?.(instanceId) ?? null;
    const mode = this.getContextEvidenceModeForInstance?.(instanceId) ?? 'off';
    if (!capabilities || mode === 'off') return;

    this.policyRuntime.observe({
      instanceId,
      usage,
      capabilities,
      mode,
      autoCompactEnabled: this.autoCompactEnabled,
      executor: this.getProviderActionExecutorForInstance?.(instanceId) ?? null,
      circuitBreakerTripped: this.isCircuitBreakerTripped(instanceId),
      onActionFailure: () => this.recordCircuitBreakerFailure(instanceId),
      onActionSuccess: () => this.resetCircuitBreaker(instanceId),
    });
  }

  async drainPolicyDecisions(instanceId: string): Promise<void> {
    await this.policyRuntime.drain(instanceId);
  }

  /**
   * Dismiss a warning for an instance
   */
  dismissWarning(instanceId: string, currentPercentage: number): void {
    this.dismissedWarnings.set(instanceId, currentPercentage);
  }

  /** Shared proof boundary for provider-native compaction observed outside an AIO request. */
  recordObservedCompaction(instanceId: string, cumulativeTokens = 0): void {
    this.policyRuntime.recordObservedCompaction(
      instanceId,
      this.latestUsage.get(instanceId),
      cumulativeTokens,
    );
  }

  recordProviderActionProof(
    instanceId: string,
    actionCode: string,
    proofStage: 'requested' | 'acknowledged' | 'observed',
  ): void {
    this.policyRuntime.recordProviderActionProof(
      instanceId,
      this.latestUsage.get(instanceId),
      actionCode,
      proofStage,
    );
  }

  private emitLegacyWarning(instanceId: string, percentage: number): void {
    const dismissedAt = this.dismissedWarnings.get(instanceId);
    if (dismissedAt !== undefined && percentage > dismissedAt + 5) {
      this.dismissedWarnings.delete(instanceId);
    }
    if (percentage < 75) {
      this.warnedInstances.delete(instanceId);
      this.dismissedWarnings.delete(instanceId);
      return;
    }
    if (this.dismissedWarnings.has(instanceId)) return;

    const legacyThreshold = percentage >= 95 ? 95 : percentage >= 80 ? 80 : 75;
    if (legacyThreshold === 75 && this.warnedInstances.has(instanceId)) return;
    if (legacyThreshold === 75) this.warnedInstances.add(instanceId);
    this.emit('context-warning', {
      instanceId,
      percentage,
      level: legacyThreshold === 95 ? 'emergency' : legacyThreshold === 80 ? 'critical' : 'warning',
      deprecated: true,
      legacyThreshold,
      decisionOwner: 'ContextSafetyPolicy',
    });
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

  /**
   * Get (or lazily create) the per-instance budget tracker.
   *
   * The static `totalBudget` set at construction is only a fallback — callers
   * should pass the instance's live `contextUsage.total` into `checkBudget()`
   * so the gate aligns with what the CLI actually reports (200k / 1M / 2M).
   * The 1M fallback avoids premature "budget full" false positives on
   * Claude Opus/Sonnet 4.6 (native 1M) before the first context event lands.
   */
  getBudgetTracker(instanceId: string, totalBudget = 1_000_000): TokenBudgetTracker {
    let tracker = this.budgetTrackers.get(instanceId);
    if (!tracker) {
      tracker = new TokenBudgetTracker({ totalBudget });
      this.budgetTrackers.set(instanceId, tracker);
    }
    return tracker;
  }

  /**
   * Reset just the budget tracker for an instance (clears continuationCount
   * and deltas) without tearing down compaction/warning/epoch state. Used on
   * user-initiated restart so stale continuation history doesn't keep the
   * diminishing-returns branch tripping after a fresh start.
   */
  resetBudgetTracker(instanceId: string): void {
    const tracker = this.budgetTrackers.get(instanceId);
    if (tracker) {
      tracker.reset();
    }
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
    this.dismissedWarnings.delete(instanceId);
    this.latestUsage.delete(instanceId);
    this.policyRuntime.cleanup(instanceId);
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
   * Legacy capability accessor retained for callers and renderer telemetry.
   * The shared policy does not exempt these providers from pressure rules.
   *
   * Public so tests and callers can verify the gating decision without
   * depending on private state.
   */
  isSelfManagedAutoCompaction(instanceId: string): boolean {
    return this.selfManagedAutoCompactionForInstance?.(instanceId) ?? false;
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

      const cumulativeNow = this.latestUsage.get(instanceId)?.cumulativeTokens
        ?? previousUsage?.cumulativeTokens;

      const result: CompactionResult = { success: true, method, blocking, previousUsage };
      this.emit('compaction-completed', { instanceId, result });
      if (method === 'restart-with-summary') {
        this.recordObservedCompaction(instanceId, cumulativeNow ?? 0);
      }

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
