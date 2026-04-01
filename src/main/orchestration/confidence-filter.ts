/**
 * Confidence Filter - Filter multi-agent results by confidence threshold
 *
 * Inspired by Claude Code's code-review plugin which uses confidence scoring
 * (0-100) to filter false positives from parallel agent reviews.
 */

import { getLogger } from '../logging/logger';
import type { AgentResponse } from '../../shared/types/verification.types';

const logger = getLogger('ConfidenceFilter');

export interface FilterResult {
  accepted: AgentResponse[];
  rejected: AgentResponse[];
  threshold: number;
}

export interface ConfidenceFilterConfig {
  /** Default confidence threshold (0-1). Responses below this are filtered out. */
  defaultThreshold: number;
}

const DEFAULT_CONFIG: ConfidenceFilterConfig = {
  defaultThreshold: 0.8,
};

export class ConfidenceFilter {
  private static instance: ConfidenceFilter | null = null;
  private config: ConfidenceFilterConfig = { ...DEFAULT_CONFIG };

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- singleton pattern
  private constructor() {}

  static getInstance(): ConfidenceFilter {
    if (!this.instance) {
      this.instance = new ConfidenceFilter();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  configure(config: Partial<ConfidenceFilterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): ConfidenceFilterConfig {
    return { ...this.config };
  }

  /**
   * Filter responses by confidence threshold.
   * Returns accepted (at or above threshold) and rejected (below threshold) arrays.
   */
  filterByThreshold(responses: AgentResponse[], threshold?: number): FilterResult {
    const t = threshold ?? this.config.defaultThreshold;
    const accepted: AgentResponse[] = [];
    const rejected: AgentResponse[] = [];

    for (const response of responses) {
      const confidence = response.confidence ?? 0;
      if (confidence >= t) {
        accepted.push(response);
      } else {
        rejected.push(response);
      }
    }

    if (rejected.length > 0) {
      logger.info('Filtered low-confidence responses', {
        total: responses.length,
        accepted: accepted.length,
        rejected: rejected.length,
        threshold: t,
      });
    }

    return { accepted, rejected, threshold: t };
  }

  /**
   * Compute aggregate confidence from multiple agent responses.
   * Uses weighted mean biased toward higher-confidence responses:
   * each response's weight equals its own confidence score.
   */
  computeAggregateConfidence(responses: AgentResponse[]): number {
    if (responses.length === 0) return 0;

    let weightedSum = 0;
    let weightTotal = 0;

    for (const response of responses) {
      const c = response.confidence ?? 0;
      weightedSum += c * c; // self-weighted
      weightTotal += c;
    }

    return weightTotal > 0 ? weightedSum / weightTotal : 0;
  }
}

export function getConfidenceFilter(): ConfidenceFilter {
  return ConfidenceFilter.getInstance();
}
