/**
 * Child Announcer - Push-based child completion notifications
 *
 * When a child instance completes (success or failure), this service
 * formats a structured announcement and emits it so the parent instance
 * receives it as an injected user message.
 *
 * Announcements are **batched per parent**: when multiple children finish
 * within a short window they are combined into a single message instead
 * of flooding the parent with one message per child.
 *
 * Inspired by OpenClaw's auto-announce pattern in subagent-registry.ts.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type {
  ChildAnnouncement,
  AnnounceConfig,
} from '../../shared/types/child-announce.types';
import { DEFAULT_ANNOUNCE_CONFIG } from '../../shared/types/child-announce.types';

const logger = getLogger('ChildAnnouncer');

/** Internal per-parent batch state */
interface PendingBatch {
  announcements: ChildAnnouncement[];
  /** Debounce timer — resets each time a new announcement arrives */
  debounceTimer: ReturnType<typeof setTimeout>;
  /** Hard-deadline timer — fires after batchMaxWaitMs regardless of debounce */
  maxWaitTimer: ReturnType<typeof setTimeout>;
  /** Timestamp of the first announcement in this batch */
  firstArrivedAt: number;
}

export class ChildAnnouncer extends EventEmitter {
  private static instance: ChildAnnouncer | null = null;
  private config: AnnounceConfig = { ...DEFAULT_ANNOUNCE_CONFIG };

  /** Pending batches keyed by parentId */
  private pending = new Map<string, PendingBatch>();

  private constructor() {
    super();
  }

  static getInstance(): ChildAnnouncer {
    if (!this.instance) {
      this.instance = new ChildAnnouncer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.flushAll();
      this.instance.removeAllListeners();
    }
    this.instance = null;
  }

  configure(config: Partial<AnnounceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): AnnounceConfig {
    return { ...this.config };
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Announce a child's completion to its parent.
   *
   * When batching is enabled (batchWindowMs > 0), the announcement is
   * queued and a debounced flush is scheduled. When batching is disabled
   * the announcement is emitted immediately (legacy behavior).
   */
  announce(announcement: ChildAnnouncement): void {
    if (!this.config.enabled) {
      logger.debug('Auto-announce disabled, skipping', { childId: announcement.childId });
      return;
    }

    if (!announcement.success && !this.config.announceFailures) {
      logger.debug('Failure announcements disabled, skipping', { childId: announcement.childId });
      return;
    }

    // Staleness guard — drop announcements that are very old
    if (this.config.staleThresholdMs > 0) {
      const age = Date.now() - announcement.completedAt;
      if (age > this.config.staleThresholdMs) {
        logger.info('Dropping stale child announcement', {
          childId: announcement.childId,
          parentId: announcement.parentId,
          ageMs: age,
          threshold: this.config.staleThresholdMs,
        });
        return;
      }
    }

    // If batching is disabled, emit immediately (legacy path)
    if (this.config.batchWindowMs <= 0) {
      this.emitBatch(announcement.parentId, [announcement]);
      return;
    }

    this.enqueue(announcement);
  }

  /**
   * Immediately flush all pending batches (e.g., during shutdown).
   */
  flushAll(): void {
    for (const parentId of [...this.pending.keys()]) {
      this.flush(parentId);
    }
  }

  /**
   * Immediately flush a specific parent's pending batch.
   */
  flush(parentId: string): void {
    const batch = this.pending.get(parentId);
    if (!batch) return;

    clearTimeout(batch.debounceTimer);
    clearTimeout(batch.maxWaitTimer);
    this.pending.delete(parentId);

    if (batch.announcements.length > 0) {
      this.emitBatch(parentId, batch.announcements);
    }
  }

  /**
   * Number of parents with pending (un-flushed) batches.
   * Useful for testing.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  // ============================================
  // Batching internals
  // ============================================

  private enqueue(announcement: ChildAnnouncement): void {
    const parentId = announcement.parentId;
    const existing = this.pending.get(parentId);

    if (existing) {
      // Add to existing batch and reset debounce timer
      existing.announcements.push(announcement);
      clearTimeout(existing.debounceTimer);
      existing.debounceTimer = setTimeout(
        () => this.flush(parentId),
        this.config.batchWindowMs
      );

      logger.debug('Batched child announcement', {
        childId: announcement.childId,
        parentId,
        batchSize: existing.announcements.length,
      });
    } else {
      // Start a new batch
      const debounceTimer = setTimeout(
        () => this.flush(parentId),
        this.config.batchWindowMs
      );
      const maxWaitTimer = setTimeout(
        () => this.flush(parentId),
        this.config.batchMaxWaitMs
      );

      this.pending.set(parentId, {
        announcements: [announcement],
        debounceTimer,
        maxWaitTimer,
        firstArrivedAt: Date.now(),
      });

      logger.debug('Started new announcement batch', {
        childId: announcement.childId,
        parentId,
      });
    }
  }

  private emitBatch(parentId: string, announcements: ChildAnnouncement[]): void {
    const message = announcements.length === 1
      ? this.formatAnnouncement(announcements[0])
      : this.formatBatchedAnnouncement(announcements);

    logger.info('Emitting child announcement batch', {
      parentId,
      count: announcements.length,
      childIds: announcements.map(a => a.childId),
    });

    this.emit('child:announced', parentId, announcements, message);
  }

  // ============================================
  // Formatting
  // ============================================

  /**
   * Format a single announcement into a human-readable message for injection
   * into the parent's conversation as a user message.
   */
  formatAnnouncement(announcement: ChildAnnouncement): string {
    const status = announcement.success ? 'completed successfully' : 'failed';
    const durationSec = (announcement.duration / 1000).toFixed(1);

    let summary = announcement.summary;
    if (summary.length > this.config.maxSummaryLength) {
      summary = summary.slice(0, this.config.maxSummaryLength) + '...';
    }

    const parts: string[] = [
      `[Child "${announcement.childName}" (${announcement.childId}) ${status} in ${durationSec}s, ${announcement.tokensUsed} tokens]`,
      '',
      summary,
    ];

    if (this.config.includeConclusions && announcement.conclusions.length > 0) {
      parts.push('', 'Conclusions:');
      for (const conclusion of announcement.conclusions) {
        parts.push(`- ${conclusion}`);
      }
    }

    if (announcement.errorClassification) {
      const ec = announcement.errorClassification;
      parts.push('', `Error: ${ec.userMessage}`);
      parts.push(`Category: ${ec.category} | Retryable: ${ec.retryable}`);
      parts.push(`Suggested action: ${ec.suggestedAction}`);
    }

    return parts.join('\n');
  }

  /**
   * Format multiple announcements into a single batched message.
   * Groups completions together so the parent sees one message instead
   * of N separate interruptions.
   */
  formatBatchedAnnouncement(announcements: ChildAnnouncement[]): string {
    const succeeded = announcements.filter(a => a.success);
    const failed = announcements.filter(a => !a.success);

    const parts: string[] = [
      `[${announcements.length} children completed — ${succeeded.length} succeeded, ${failed.length} failed]`,
      '',
    ];

    for (const announcement of announcements) {
      const status = announcement.success ? '✓' : '✗';
      const durationSec = (announcement.duration / 1000).toFixed(1);

      let summary = announcement.summary;
      // Use a shorter limit per child in batches to keep the message compact
      const perChildLimit = Math.min(this.config.maxSummaryLength, 500);
      if (summary.length > perChildLimit) {
        summary = summary.slice(0, perChildLimit) + '...';
      }

      parts.push(`${status} "${announcement.childName}" (${announcement.childId}) — ${durationSec}s, ${announcement.tokensUsed} tokens`);
      parts.push(`  ${summary}`);

      if (this.config.includeConclusions && announcement.conclusions.length > 0) {
        for (const conclusion of announcement.conclusions) {
          parts.push(`  - ${conclusion}`);
        }
      }

      if (announcement.errorClassification) {
        const ec = announcement.errorClassification;
        parts.push(`  Error: ${ec.userMessage} (${ec.suggestedAction})`);
      }

      parts.push('');
    }

    return parts.join('\n').trimEnd();
  }
}

export function getChildAnnouncer(): ChildAnnouncer {
  return ChildAnnouncer.getInstance();
}
