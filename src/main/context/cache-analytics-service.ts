/**
 * WS8 cache-efficiency analytics.
 *
 * Accumulates a bounded per-instance series of prompt-cache samples from the
 * per-turn usage seam (`recordCompletionCost`), detects cache *breaks*
 * (hit-ratio collapse >50% vs the trailing median while the input did not
 * shrink), and correlates a break with the most recent config-affecting
 * event (model change, yolo respawn, MCP-affecting settings change).
 *
 * Pure observability: nothing here alters what is sent to a provider.
 */

import type {
  CacheAnalyticsReport,
  CacheBreakEvent,
  CacheConfigEvent,
  CacheTurnSample,
} from '../../shared/types/context-attribution.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('CacheAnalyticsService');

const MAX_SAMPLES_PER_INSTANCE = 200;
const MAX_CONFIG_EVENTS_PER_INSTANCE = 20;
const MAX_TRACKED_INSTANCES = 500;
const REPORT_SAMPLE_LIMIT = 60;
/** Ratios needed before break detection can trust a trailing median. */
const MIN_PRIOR_SAMPLES_FOR_BREAK = 3;
/** Trailing window the median is computed over. */
const TRAILING_WINDOW = 8;
/** A break = ratio below this fraction of the trailing median. */
const BREAK_RATIO_FACTOR = 0.5;
/** Input must be at least this fraction of the previous turn's to count. */
const INPUT_NOT_SHRUNK_FACTOR = 0.8;
/** A config event within this window of the break is named as probable cause. */
const CAUSE_CORRELATION_WINDOW_MS = 10 * 60 * 1000;

interface InstanceCacheState {
  samples: CacheTurnSample[];
  configEvents: CacheConfigEvent[];
  lastBreak?: CacheBreakEvent;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface CacheTurnInput {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  at?: number;
}

export class CacheAnalyticsService {
  private static instance: CacheAnalyticsService | null = null;

  /** Insertion order doubles as LRU order — re-insert on write. */
  private readonly states = new Map<string, InstanceCacheState>();

  static getInstance(): CacheAnalyticsService {
    if (!this.instance) this.instance = new CacheAnalyticsService();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Record one completed turn's usage. Fail-soft by contract of the caller. */
  recordTurn(instanceId: string, turn: CacheTurnInput): void {
    const at = turn.at ?? Date.now();
    const input = Math.max(0, turn.input);
    const cacheRead = Math.max(0, turn.cacheRead);
    const denominator = input + cacheRead;
    if (denominator === 0) {
      // Nothing cacheable was reported for this turn — no signal either way.
      return;
    }
    const sample: CacheTurnSample = {
      at,
      input,
      cacheRead,
      cacheWrite: Math.max(0, turn.cacheWrite),
      ratio: cacheRead / denominator,
    };

    const state = this.takeState(instanceId);
    const detected = this.detectBreak(state, sample);
    state.samples.push(sample);
    if (state.samples.length > MAX_SAMPLES_PER_INSTANCE) {
      state.samples.splice(0, state.samples.length - MAX_SAMPLES_PER_INSTANCE);
    }
    if (detected) {
      state.lastBreak = detected;
      logger.info('Prompt-cache break detected', {
        instanceId,
        ratio: Number(detected.ratio.toFixed(3)),
        trailingMedian: Number(detected.trailingMedian.toFixed(3)),
        probableCause: detected.probableCause ?? 'unknown',
      });
    }
  }

  /** Note a config-affecting event for later break correlation. */
  noteConfigEvent(instanceId: string, kind: string, at = Date.now()): void {
    const state = this.takeState(instanceId);
    state.configEvents.push({ at, kind });
    if (state.configEvents.length > MAX_CONFIG_EVENTS_PER_INSTANCE) {
      state.configEvents.splice(0, state.configEvents.length - MAX_CONFIG_EVENTS_PER_INSTANCE);
    }
  }

  /** Note a config event for every currently tracked instance (settings changes). */
  noteGlobalConfigEvent(kind: string, at = Date.now()): void {
    for (const state of this.states.values()) {
      state.configEvents.push({ at, kind });
      if (state.configEvents.length > MAX_CONFIG_EVENTS_PER_INSTANCE) {
        state.configEvents.splice(0, state.configEvents.length - MAX_CONFIG_EVENTS_PER_INSTANCE);
      }
    }
  }

  getReport(instanceId: string): CacheAnalyticsReport {
    const state = this.states.get(instanceId);
    if (!state) {
      return { instanceId, samples: [] };
    }
    return {
      instanceId,
      samples: state.samples.slice(-REPORT_SAMPLE_LIMIT),
      ...(state.lastBreak ? { lastBreak: state.lastBreak } : {}),
    };
  }

  /** Drop all state for a removed instance. */
  removeInstance(instanceId: string): void {
    this.states.delete(instanceId);
  }

  private takeState(instanceId: string): InstanceCacheState {
    let state = this.states.get(instanceId);
    if (state) {
      // Refresh LRU position.
      this.states.delete(instanceId);
    } else {
      state = { samples: [], configEvents: [] };
    }
    this.states.set(instanceId, state);
    if (this.states.size > MAX_TRACKED_INSTANCES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    return state;
  }

  private detectBreak(
    state: InstanceCacheState,
    sample: CacheTurnSample,
  ): CacheBreakEvent | undefined {
    const prior = state.samples.slice(-TRAILING_WINDOW);
    if (prior.length < MIN_PRIOR_SAMPLES_FOR_BREAK) return undefined;
    const trailingMedian = median(prior.map((item) => item.ratio));
    if (trailingMedian <= 0) return undefined;
    if (sample.ratio >= trailingMedian * BREAK_RATIO_FACTOR) return undefined;

    // A ratio drop caused by the prompt simply getting shorter is not a break.
    const previous = state.samples[state.samples.length - 1];
    const previousPromptSize = previous.input + previous.cacheRead;
    const currentPromptSize = sample.input + sample.cacheRead;
    if (currentPromptSize < previousPromptSize * INPUT_NOT_SHRUNK_FACTOR) return undefined;

    const cause = [...state.configEvents]
      .reverse()
      .find((event) => sample.at - event.at <= CAUSE_CORRELATION_WINDOW_MS && event.at <= sample.at);

    return {
      at: sample.at,
      ratio: sample.ratio,
      trailingMedian,
      ...(cause ? { probableCause: cause.kind } : {}),
    };
  }
}

export function getCacheAnalyticsService(): CacheAnalyticsService {
  return CacheAnalyticsService.getInstance();
}
