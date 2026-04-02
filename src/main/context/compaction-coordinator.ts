/**
 * Compaction Coordinator
 *
 * Monitors instance context usage and coordinates automatic compaction.
 * - Warning at 75% (notifies renderer)
 * - Auto-compact at 80%
 * - Emergency mode at 95% (blocks input until compacted)
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { ContextUsage } from '../../shared/types/instance.types';
import { TokenBudgetTracker } from './token-budget-tracker';
import { CompactionEpochTracker } from './compaction-epoch';

const logger = getLogger('CompactionCoordinator');

export interface CompactionResult {
  success: boolean;
  method: 'native' | 'restart-with-summary';
  previousUsage?: ContextUsage;
  newUsage?: ContextUsage;
  summary?: string;
  error?: string;
}

export type CompactionStrategy = (instanceId: string) => Promise<boolean>;

export class CompactionCoordinator extends EventEmitter {
  // Thresholds
  private readonly WARNING_THRESHOLD = 75;
  private readonly COMPACT_THRESHOLD = 80;
  private readonly EMERGENCY_THRESHOLD = 95;

  // Track which instances have been warned/compacted to avoid re-triggering
  private warnedInstances = new Set<string>();
  private compactingInstances = new Set<string>();

  // Debounce: track last compaction time per instance
  private lastCompactionTime = new Map<string, number>();
  private readonly COMPACTION_COOLDOWN_MS = 30000; // 30 second cooldown

  // Dismissed warnings (reset if percentage increases by >5%)
  private dismissedWarnings = new Map<string, number>(); // instanceId -> percentage when dismissed

  // Track latest context usage per instance (for populating CompactionResult)
  private latestUsage = new Map<string, ContextUsage>();

  // Per-instance budget and epoch trackers
  private budgetTrackers = new Map<string, TokenBudgetTracker>();
  private epochTrackers = new Map<string, CompactionEpochTracker>();

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
   * Called on every contextUsage update (from batch-update events)
   */
  onContextUpdate(instanceId: string, usage: ContextUsage): void {
    this.latestUsage.set(instanceId, usage);
    const percentage = usage.percentage;

    // Check if a dismissed warning should re-appear (usage increased >5% since dismissal)
    const dismissedAt = this.dismissedWarnings.get(instanceId);
    if (dismissedAt !== undefined && percentage > dismissedAt + 5) {
      this.dismissedWarnings.delete(instanceId);
    }

    // Emergency threshold (95%+)
    if (percentage >= this.EMERGENCY_THRESHOLD) {
      this.emit('context-warning', {
        instanceId,
        percentage,
        level: 'emergency' as const,
      });

      if (this.autoCompactEnabled && !this.compactingInstances.has(instanceId)) {
        void this.triggerAutoCompact(instanceId, usage);
      }
      return;
    }

    // Auto-compact threshold (80%+)
    if (percentage >= this.COMPACT_THRESHOLD) {
      if (!this.dismissedWarnings.has(instanceId)) {
        this.emit('context-warning', {
          instanceId,
          percentage,
          level: 'critical' as const,
        });
      }

      if (this.autoCompactEnabled && !this.compactingInstances.has(instanceId)) {
        void this.triggerAutoCompact(instanceId, usage);
      }
      return;
    }

    // Warning threshold (75%+)
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
      return { success: false, method: 'native', error: 'Compaction already in progress' };
    }

    return this.executeCompaction(instanceId);
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
    this.lastCompactionTime.delete(instanceId);
    this.dismissedWarnings.delete(instanceId);
    this.latestUsage.delete(instanceId);
    this.budgetTrackers.delete(instanceId);
    this.epochTrackers.delete(instanceId);
  }

  /**
   * Check if an instance is currently compacting
   */
  isCompacting(instanceId: string): boolean {
    return this.compactingInstances.has(instanceId);
  }

  private async triggerAutoCompact(instanceId: string, usage: ContextUsage): Promise<void> {
    // Check cooldown
    const lastTime = this.lastCompactionTime.get(instanceId);
    if (lastTime && Date.now() - lastTime < this.COMPACTION_COOLDOWN_MS) {
      logger.debug('Skipping auto-compact (cooldown)', { instanceId });
      return;
    }

    logger.info('Auto-compact triggered', { instanceId, percentage: usage.percentage });

    const result = await this.executeCompaction(instanceId);

    if (!result.success) {
      logger.warn('Auto-compact failed', { instanceId, error: result.error });
    }
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

  private async executeCompaction(instanceId: string): Promise<CompactionResult> {
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
        success = await this.nativeCompactStrategy(instanceId);
        method = 'native';
      }

      if (!success && this.restartCompactStrategy) {
        // Fallback to restart-with-summary
        success = await this.restartCompactStrategy(instanceId);
        method = 'restart-with-summary';
      }

      // Always set cooldown to prevent retry loops on failure
      this.lastCompactionTime.set(instanceId, Date.now());

      if (!success) {
        const result: CompactionResult = {
          success: false,
          method,
          previousUsage,
          error: 'No compaction strategy available or all strategies failed',
        };
        this.emit('compaction-completed', { instanceId, result });
        return result;
      }

      this.warnedInstances.delete(instanceId);
      this.dismissedWarnings.delete(instanceId);

      const result: CompactionResult = { success: true, method, previousUsage };
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
