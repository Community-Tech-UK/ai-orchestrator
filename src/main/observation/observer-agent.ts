import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import { getObservationIngestor } from './observation-ingestor';
import { getObservationStore } from './observation-store';
import type { RawObservation, Observation, ObservationConfig } from '../../shared/types/observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from '../../shared/types/observation.types';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'at', 'by', 'with', 'from', 'as', 'it', 'its', 'this', 'that',
  'and', 'or', 'but', 'not', 'no', 'if', 'then', 'else', 'so', 'up',
  'out', 'about', 'into', 'over', 'after', 'before', 'between', 'under',
]);
const MAX_ANALYZED_EVENT_CONTENT_CHARS = 2_000;

/**
 * ObserverAgent - Compresses raw observations into Observation summaries
 *
 * Listens to ingestor:flush-ready events and uses heuristic methods (NO LLM)
 * to compress raw events into structured observations with themes, findings, and signals.
 */
export class ObserverAgent extends EventEmitter {
  private static instance: ObserverAgent | null = null;

  private logger = getLogger('ObserverAgent');
  private config = { ...DEFAULT_OBSERVATION_CONFIG };
  private observationCount = 0;

  static getInstance(): ObserverAgent {
    if (!this.instance) {
      this.instance = new ObserverAgent();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();

    // Wire up listener to ingestor flush events
    getObservationIngestor().on('ingestor:flush-ready', (rawObservations: RawObservation[]) => {
      this.processFlush(rawObservations);
    });

    this.logger.info('ObserverAgent initialized');
  }

  /**
   * Process a batch of raw observations from the ingestor
   */
  private processFlush(rawObservations: RawObservation[]): void {
    if (rawObservations.length === 0) {
      return;
    }

    this.logger.debug('Processing flush', { count: rawObservations.length });

    // Group by source
    const grouped = new Map<string, RawObservation[]>();
    for (const raw of rawObservations) {
      const existing = grouped.get(raw.source) || [];
      existing.push(raw);
      grouped.set(raw.source, existing);
    }

    // Compress each group
    let created = 0;
    for (const [source, events] of grouped.entries()) {
      try {
        const observationData = this.compressGroup(source, events);
        const observation: Observation = {
          id: generateId(),
          ...observationData,
        };

        // Store observation
        getObservationStore().storeObservation(observation);

        // Emit creation event
        this.emit('observer:observation-created', observation);
        created++;

        this.logger.debug('Observation created', {
          id: observation.id,
          source,
          eventCount: events.length,
          themes: observation.themes,
        });
      } catch (error) {
        this.logger.error('Failed to compress observation group', error as Error, { source });
      }
    }

    // Update observation count and check reflection threshold
    this.observationCount += created;
    if (this.observationCount >= this.config.reflectObservationThreshold) {
      this.logger.info('Reflection threshold reached', {
        count: this.observationCount,
        threshold: this.config.reflectObservationThreshold,
      });
      this.emit('observer:reflect-ready');
      this.observationCount = 0;
    }

    this.logger.info('Flush processed', { created, totalObservations: this.observationCount });
  }

  /**
   * Compress a group of raw observations into a single Observation
   */
  private compressGroup(source: string, events: RawObservation[]): Omit<Observation, 'id'> {
    // Extract instance IDs
    const instanceIds = Array.from(new Set(
      events.map(e => e.instanceId).filter((id): id is string => id !== undefined)
    ));

    // Extract themes, findings, and signals
    const themes = this.extractThemes(events);
    const keyFindings = this.extractKeyFindings(events);
    const signals = this.detectSignals(events);

    // Build summary: first 200 chars of themes joined + event count
    const themeSummary = themes.join(', ').substring(0, 200);
    const summary = `${themeSummary} [${events.length} events from ${source}]`;

    // Calculate total token count
    const tokenCount = events.reduce((sum, e) => sum + (e.tokenEstimate || 0), 0);

    // Collect source IDs
    const sourceIds = events.map(e => e.id);

    return {
      timestamp: events[0].timestamp,
      instanceIds,
      summary,
      themes,
      keyFindings,
      successSignals: signals.success,
      failureSignals: signals.failure,
      tokenCount,
      sourceIds,
      createdAt: Date.now(),
      ttl: this.config.observationTtlMs,
      promoted: false,
    };
  }

  /**
   * Extract themes using keyword frequency analysis
   */
  private extractThemes(events: RawObservation[]): string[] {
    const wordCounts = new Map<string, number>();

    for (const event of events) {
      const content = this.getAnalyzableContent(event.content).toLowerCase();
      const words = content.split(/\s+/);

      for (const word of words) {
        // Clean word: remove punctuation
        const cleaned = word.replace(/[^\w]/g, '');
        if (cleaned.length < 3) continue;
        if (STOP_WORDS.has(cleaned)) continue;

        wordCounts.set(cleaned, (wordCounts.get(cleaned) || 0) + 1);
      }
    }

    // Filter words with at least 2 occurrences and sort by frequency
    const themes = Array.from(wordCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);

    return themes;
  }

  /**
   * Extract key findings from notable events
   */
  private extractKeyFindings(events: RawObservation[]): string[] {
    const findings: string[] = [];

    // First, look for milestone or critical events
    const notableEvents = events.filter(e => e.level === 'milestone' || e.level === 'critical');

    if (notableEvents.length > 0) {
      for (const event of notableEvents.slice(0, 5)) {
        findings.push(this.getAnalyzableContent(event.content).substring(0, 100));
      }
    } else {
      // Fall back to first 3 events
      for (const event of events.slice(0, 3)) {
        findings.push(this.getAnalyzableContent(event.content).substring(0, 80));
      }
    }

    return findings.slice(0, 5);
  }

  /**
   * Detect success and failure signals in events
   */
  private detectSignals(events: RawObservation[]): { success: number; failure: number } {
    const signals = { success: 0, failure: 0 };

    const successKeywords = ['success', 'completed', 'passed', 'resolved', 'done', 'idle'];
    const failureKeywords = ['error', 'failed', 'timeout', 'crashed', 'exception', 'rejected'];

    for (const event of events) {
      const contentLower = this.getAnalyzableContent(event.content).toLowerCase();

      // Check for success signals
      const hasSuccessKeyword = successKeywords.some(kw => contentLower.includes(kw));
      const hasSuccessMetadata = event.metadata?.['status'] === 'idle' || event.metadata?.['success'] === true;

      if (hasSuccessKeyword || hasSuccessMetadata) {
        signals.success++;
      }

      // Check for failure signals
      const hasFailureKeyword = failureKeywords.some(kw => contentLower.includes(kw));

      if (hasFailureKeyword) {
        signals.failure++;
      }
    }

    return signals;
  }

  private getAnalyzableContent(content: string): string {
    if (content.length <= MAX_ANALYZED_EVENT_CONTENT_CHARS) {
      return content;
    }

    return content.slice(0, MAX_ANALYZED_EVENT_CONTENT_CHARS);
  }

  /**
   * Get current statistics
   */
  getStats(): { observationCount: number } {
    return {
      observationCount: this.observationCount,
    };
  }

  /**
   * Configure the observer agent
   */
  configure(config: Partial<ObservationConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Configuration updated', { config: this.config });
  }
}

/**
 * Get the singleton ObserverAgent instance
 */
export function getObserverAgent(): ObserverAgent {
  return ObserverAgent.getInstance();
}
