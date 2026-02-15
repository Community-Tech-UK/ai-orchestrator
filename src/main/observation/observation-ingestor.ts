import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import type {
  RawObservation,
  ObservationLevel,
  ObservationSource,
  ObservationConfig,
} from '../../shared/types/observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from '../../shared/types/observation.types';
import type { InstanceManager } from '../instance/instance-manager';

/**
 * ObservationIngestor captures events from the orchestrator and buffers them
 * before flushing to the observer agent. Uses ring buffer to prevent memory leaks.
 */
export class ObservationIngestor extends EventEmitter {
  private static instance: ObservationIngestor;

  static getInstance(): ObservationIngestor {
    if (!this.instance) {
      this.instance = new ObservationIngestor();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      this.instance = undefined as unknown as ObservationIngestor;
    }
  }

  private readonly logger = getLogger('ObservationIngestor');
  private config: ObservationConfig = { ...DEFAULT_OBSERVATION_CONFIG };

  private ringBuffer: RawObservation[] = [];
  private cumulativeTokenCount = 0;
  private lastFlushTimestamp = Date.now();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
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

        const content = JSON.stringify(message);
        const metadata: Record<string, unknown> = {
          messageType: typeof message === 'object' && message !== null
            ? (message as Record<string, unknown>)['type']
            : undefined
        };
        this.captureEvent(
          'instance:output',
          'event',
          content,
          metadata,
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

    // Create raw observation
    const tokenEstimate = Math.ceil(filteredContent.length / 4);
    const observation: RawObservation = {
      id: `obs-${generateId()}`,
      timestamp: Date.now(),
      source,
      level,
      content: filteredContent,
      metadata,
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
