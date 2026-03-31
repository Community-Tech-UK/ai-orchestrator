/**
 * Child Announcer - Push-based child completion notifications
 *
 * When a child instance completes (success or failure), this service
 * formats a structured announcement and emits it so the parent instance
 * receives it as an injected user message.
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

export class ChildAnnouncer extends EventEmitter {
  private static instance: ChildAnnouncer | null = null;
  private config: AnnounceConfig = { ...DEFAULT_ANNOUNCE_CONFIG };

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

  /**
   * Announce a child's completion to its parent.
   * Emits 'child:announced' with the announcement and formatted message.
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

    const message = this.formatAnnouncement(announcement);

    logger.info('Announcing child completion', {
      childId: announcement.childId,
      parentId: announcement.parentId,
      success: announcement.success,
      duration: announcement.duration,
    });

    this.emit('child:announced', announcement, message);
  }

  /**
   * Format an announcement into a human-readable message for injection
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
}

export function getChildAnnouncer(): ChildAnnouncer {
  return ChildAnnouncer.getInstance();
}
