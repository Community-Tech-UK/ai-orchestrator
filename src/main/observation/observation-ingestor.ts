import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import type {
  RawObservation,
  ObservationLevel,
  ObservationSource,
  ObservationConfig,
} from './observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from './observation.types';
import type { InstanceManager } from '../instance/instance-manager';

const MAX_CAPTURED_OBSERVATION_CHARS = 4_000;
const MAX_OUTPUT_MESSAGE_PREVIEW_CHARS = 600;
const DEFAULT_RESUME_FLUSH_GRACE_MS = 60_000;

/**
 * ObservationIngestor captures events from the orchestrator and buffers them
 * before flushing to the observer agent. Uses ring buffer to prevent memory leaks.
 */
export class ObservationIngestor extends EventEmitter {
  private static instance: ObservationIngestor | null = null;

  static getInstance(): ObservationIngestor {
    if (!this.instance) {
      this.instance = new ObservationIngestor();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      this.instance = null;
    }
  }

  private readonly logger = getLogger('ObservationIngestor');
  private config: ObservationConfig = { ...DEFAULT_OBSERVATION_CONFIG };

  private ringBuffer: RawObservation[] = [];
  private cumulativeTokenCount = 0;
  private lastFlushTimestamp = Date.now();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushDeferredUntil = 0;
  private initialized = false;
  private totalCaptured = 0;

  private constructor() {
    super();
  }

  /**
   * Initialize the ingestor by attaching event listeners to the instance manager.
   * Should only be called once.
   */
  initialize(instanceManager: InstanceManager): void {
    if (this.initialized) {
      this.logger.warn('ObservationIngestor already initialized, skipping');
      return;
    }

    this.logger.info('Initializing ObservationIngestor');

    // Attach listeners to instance manager events
    instanceManager.on('instance:output', (data: unknown) => {
      try {
        if (!data || typeof data !== 'object') {
          return;
        }
        const { instanceId, message } = data as Record<string, unknown>;
        if (!instanceId || !message) {
          return;
        }

        const summarized = this.summarizeOutputMessage(message);
        this.captureEvent(
          'instance:output',
          'event',
          summarized.content,
          summarized.metadata,
          String(instanceId)
        );
      } catch (error) {
        this.logger.warn('Failed to capture instance:output event', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    instanceManager.on('instance:state-update', (data: unknown) => {
      try {
        if (!data || typeof data !== 'object') {
          return;
        }
        const { instanceId, status } = data as Record<string, unknown>;
        if (!instanceId || !status) {
          return;
        }

        const content = `Instance ${instanceId} changed to status: ${status}`;
        const metadata: Record<string, unknown> = { status };
        this.captureEvent(
          'instance:state-update',
          'event',
          content,
          metadata,
          String(instanceId)
        );
      } catch (error) {
        this.logger.warn('Failed to capture instance:state-update event', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });

    // Set up periodic flush timer
    this.flushTimer = setInterval(() => {
      if (this.isFlushDeferred()) {
        return;
      }
      const timeSinceLastFlush = Date.now() - this.lastFlushTimestamp;
      if (timeSinceLastFlush >= this.config.observeTimeThresholdMs) {
        this.logger.debug('Periodic flush triggered by time threshold');
        this.flush();
      }
    }, this.config.observeTimeThresholdMs);

    this.initialized = true;
    this.logger.info('ObservationIngestor initialized successfully');
  }

  /**
   * Core capture method that buffers observations and triggers flush when thresholds are met.
   */
  captureEvent(
    source: ObservationSource,
    level: ObservationLevel,
    content: string,
    metadata: Record<string, unknown>,
    instanceId?: string,
    sessionId?: string
  ): void {
    if (!this.config.enabled) {
      return;
    }

    // Check if level meets minimum threshold
    if (this.levelToNumber(level) < this.levelToNumber(this.config.minLevel)) {
      return;
    }

    // Apply privacy filtering if enabled
    const filteredContent = this.config.enablePrivacyFiltering
      ? this.anonymize(content)
      : content;
    const normalizedContent = this.normalizeContent(filteredContent);
    const wasTruncated = normalizedContent.length > MAX_CAPTURED_OBSERVATION_CHARS;
    const boundedContent = wasTruncated
      ? `${normalizedContent.slice(0, MAX_CAPTURED_OBSERVATION_CHARS)}... (${normalizedContent.length} chars)`
      : normalizedContent;
    const observationMetadata = wasTruncated
      ? {
          ...metadata,
          originalContentLength: normalizedContent.length,
        }
      : metadata;

    // Create raw observation
    const tokenEstimate = Math.ceil(boundedContent.length / 4);
    const observation: RawObservation = {
      id: `obs-${generateId()}`,
      timestamp: Date.now(),
      source,
      level,
      content: boundedContent,
      metadata: observationMetadata,
      instanceId,
      sessionId,
      tokenEstimate,
    };

    // Add to ring buffer (maintain max size)
    if (this.ringBuffer.length >= this.config.ringBufferSize) {
      this.ringBuffer.shift(); // Remove oldest
    }
    this.ringBuffer.push(observation);

    // Update counters
    this.cumulativeTokenCount += tokenEstimate;
    this.totalCaptured++;

    // Check if we should flush based on token threshold
    if (this.cumulativeTokenCount >= this.config.observeTokenThreshold) {
      if (this.isFlushDeferred()) {
        this.logger.debug('Skipping token-threshold flush during post-resume grace period', {
          cumulativeTokens: this.cumulativeTokenCount,
          deferredUntil: this.flushDeferredUntil,
        });
        return;
      }
      this.logger.debug('Flush triggered by token threshold', {
        cumulativeTokens: this.cumulativeTokenCount,
        threshold: this.config.observeTokenThreshold,
      });
      this.flush();
    }
  }

  /**
   * Drain the buffer and emit flush-ready event with captured observations.
   */
  private flush(): void {
    if (this.ringBuffer.length === 0) {
      return;
    }

    // Copy buffer and reset state
    const observations = [...this.ringBuffer];
    this.ringBuffer = [];
    this.cumulativeTokenCount = 0;
    this.lastFlushTimestamp = Date.now();

    // Emit flush event
    this.emit('ingestor:flush-ready', observations);

    this.logger.debug('Flushed observation buffer', {
      count: observations.length,
      totalCaptured: this.totalCaptured,
    });
  }

  /**
   * Apply privacy filtering to remove sensitive information.
   * Reuses patterns from cross-project-learner.ts.
   */
  private anonymize(content: string): string {
    let filtered = content;

    // Replace URLs
    filtered = filtered.replace(/https?:\/\/[^\s<>"{}|\\^`[\]]+/g, '<URL>');

    // Replace Unix file paths
    filtered = filtered.replace(
      /(?:^|[^:])(?:\/[a-zA-Z0-9._-]+){2,}(?:\/[a-zA-Z0-9._-]*)?/g,
      '<PATH>'
    );

    // Replace Windows paths
    filtered = filtered.replace(
      /[A-Za-z]:\\(?:[^\\:*?"<>|\r\n]+\\)*[^\\:*?"<>|\r\n]*/g,
      '<PATH>'
    );

    // Replace emails
    filtered = filtered.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      '<EMAIL>'
    );

    // Replace UUIDs
    filtered = filtered.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<UUID>'
    );

    // Replace hashes (40-character hex strings)
    filtered = filtered.replace(/\b[0-9a-f]{40}\b/gi, '<HASH>');

    return filtered;
  }

  private summarizeOutputMessage(message: unknown): {
    content: string;
    metadata: Record<string, unknown>;
  } {
    if (!message || typeof message !== 'object') {
      return {
        content: this.normalizeContent(String(message ?? '')),
        metadata: {
          messageType: typeof message,
        },
      };
    }

    const messageRecord = message as Record<string, unknown>;
    const messageType = typeof messageRecord['type'] === 'string'
      ? messageRecord['type']
      : 'unknown';
    const rawContent = typeof messageRecord['content'] === 'string'
      ? messageRecord['content']
      : '';
    const attachments = Array.isArray(messageRecord['attachments'])
      ? messageRecord['attachments']
      : [];
    const messageMetadata = messageRecord['metadata'];
    const metadataKeys = messageMetadata && typeof messageMetadata === 'object'
      ? Object.keys(messageMetadata as Record<string, unknown>).slice(0, 8)
      : undefined;
    const preview = rawContent.length > 0
      ? this.previewText(rawContent)
      : '[no text content]';

    return {
      content: `${messageType}: ${preview}`,
      metadata: {
        messageType,
        contentLength: rawContent.length,
        attachmentCount: attachments.length,
        metadataKeys,
      },
    };
  }

  private previewText(value: string): string {
    const normalized = this.normalizeContent(value);
    if (normalized.length <= MAX_OUTPUT_MESSAGE_PREVIEW_CHARS) {
      return normalized;
    }
    return `${normalized.slice(0, MAX_OUTPUT_MESSAGE_PREVIEW_CHARS)}... (${normalized.length} chars)`;
  }

  private normalizeContent(content: string): string {
    return content.replace(/\s+/g, ' ').trim();
  }

  private isFlushDeferred(now = Date.now()): boolean {
    if (this.flushDeferredUntil === 0) {
      return false;
    }

    if (now >= this.flushDeferredUntil) {
      this.flushDeferredUntil = 0;
      return false;
    }

    return true;
  }

  /**
   * Convert observation level to numeric value for comparison.
   */
  private levelToNumber(level: ObservationLevel): number {
    const levels: Record<ObservationLevel, number> = {
      trace: 0,
      event: 1,
      milestone: 2,
      critical: 3,
    };
    return levels[level] ?? 0;
  }

  /**
   * Get current buffer size.
   */
  getBufferSize(): number {
    return this.ringBuffer.length;
  }

  /**
   * Get statistics about captured observations.
   */
  getStats(): {
    totalCaptured: number;
    bufferSize: number;
    cumulativeTokens: number;
    lastFlushTimestamp: number;
  } {
    return {
      totalCaptured: this.totalCaptured,
      bufferSize: this.ringBuffer.length,
      cumulativeTokens: this.cumulativeTokenCount,
      lastFlushTimestamp: this.lastFlushTimestamp,
    };
  }

  /**
   * Update configuration, potentially restarting the flush timer.
   */
  configure(partialConfig: Partial<ObservationConfig>): void {
    const oldTimeThreshold = this.config.observeTimeThresholdMs;
    this.config = { ...this.config, ...partialConfig };

    this.logger.info('Configuration updated', { config: this.config });

    // Restart timer if time threshold changed
    if (
      this.initialized &&
      oldTimeThreshold !== this.config.observeTimeThresholdMs
    ) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
      }

      this.flushTimer = setInterval(() => {
        if (this.isFlushDeferred()) {
          return;
        }
        const timeSinceLastFlush = Date.now() - this.lastFlushTimestamp;
        if (timeSinceLastFlush >= this.config.observeTimeThresholdMs) {
          this.logger.debug('Periodic flush triggered by time threshold');
          this.flush();
        }
      }, this.config.observeTimeThresholdMs);
    }
  }

  /**
   * Force an immediate flush regardless of thresholds.
   */
  forceFlush(): void {
    this.flush();
  }

  handleSystemSuspend(): void {
    this.logger.info('Observation flush timer noted system suspend');
  }

  handleSystemResume(graceMs = DEFAULT_RESUME_FLUSH_GRACE_MS): void {
    const normalizedGraceMs = Math.max(0, graceMs);
    this.lastFlushTimestamp = Date.now();
    this.flushDeferredUntil = this.lastFlushTimestamp + normalizedGraceMs;

    this.logger.info('Observation flush timer deferred after system resume', {
      graceMs: normalizedGraceMs,
      deferredUntil: this.flushDeferredUntil,
      bufferedObservations: this.ringBuffer.length,
      bufferedTokens: this.cumulativeTokenCount,
    });
  }

  /**
   * Clean up resources and reset state.
   */
  cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    this.ringBuffer = [];
    this.cumulativeTokenCount = 0;
    this.flushDeferredUntil = 0;
    this.totalCaptured = 0;
    this.initialized = false;

    this.logger.info('ObservationIngestor cleaned up');
  }
}

/**
 * Convenience getter for singleton instance.
 */
export function getObservationIngestor(): ObservationIngestor {
  return ObservationIngestor.getInstance();
}
