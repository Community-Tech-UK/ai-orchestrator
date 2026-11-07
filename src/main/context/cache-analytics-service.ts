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

import { assessCacheMiss, type CacheMissSample } from './cache-miss';
import { getModelRate, getCacheReadMultiplier, getCacheWriteMultiplier, hasModelRate } from '../../shared/data/model-pricing';
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
/** Recently accounted provider call ids kept per instance for once-per-call accounting. */
const MAX_ACCOUNTED_CALL_IDS = 64;

interface InstanceCacheState {
  samples: CacheTurnSample[];
  configEvents: CacheConfigEvent[];
  lastBreak?: CacheBreakEvent;
  previous?: CacheMissSample;
  turnStartedAt?: number;
  afterCompaction?: boolean;
  rewriteTokens: number;
  rewriteCostUsd: number;
  expectedRewriteTokens: number;
  hasUnpricedRewrite: boolean;
  rewriteIsEstimated: boolean;
  /** Insertion order doubles as FIFO eviction order. */
  accountedCallIds: Set<string>;
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
  promptTokens?: number;
  model?: string;
  provider?: string;
  ttlMs?: number;
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
    const cacheWrite = Math.max(0, turn.cacheWrite);
    const denominator = input + cacheRead;
    if (denominator === 0 && cacheWrite === 0) {
      // Nothing cacheable was reported for this turn — no signal either way.
      return;
    }
    const sample: CacheTurnSample = {
      at,
      input,
      cacheRead,
      cacheWrite,
      ratio: denominator > 0 ? cacheRead / denominator : 0,
    };

    const state = this.takeState(instanceId);
    if (turn.model || turn.promptTokens !== undefined) this.recordMiss(state, { ...turn, cacheRead, cacheWrite, promptTokens: turn.promptTokens ?? input + cacheRead + cacheWrite, at, exact: false });
    const detected = turn.model || turn.promptTokens !== undefined ? undefined : this.detectBreak(state, sample);
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

  /** Exact Claude per-call samples never let a helper replace the main baseline. */
  recordCall(instanceId: string, call: { uncachedInput: number; cacheRead: number; cacheWrite: number;
    mainThread: boolean; at?: number; model?: string; provider?: string; ttlMs?: number; callId?: string }): void {
    if (!call.mainThread) return;
    const at = call.at ?? Date.now();
    const promptTokens = call.uncachedInput + call.cacheRead + call.cacheWrite;
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) return;
    const state = this.takeState(instanceId);
    // One provider call can arrive as several assistant stream frames that
    // share `callId` and re-report the same call usage. Account the call once:
    // repeating `recordMiss` for each frame charges the same cache rewrite over
    // and over. An absent id keeps per-frame accounting (no identity to group).
    if (call.callId !== undefined) {
      if (state.accountedCallIds.has(call.callId)) return;
      state.accountedCallIds.add(call.callId);
      if (state.accountedCallIds.size > MAX_ACCOUNTED_CALL_IDS) {
        const oldest = state.accountedCallIds.keys().next().value;
        if (oldest !== undefined) state.accountedCallIds.delete(oldest);
      }
    }
    this.recordMiss(state, { ...call, promptTokens, at, exact: true });
    state.samples.push({ at, input: call.uncachedInput, cacheRead: call.cacheRead, cacheWrite: call.cacheWrite,
      ratio: call.cacheRead / promptTokens, promptTokens, model: call.model });
    if (state.samples.length > MAX_SAMPLES_PER_INSTANCE) state.samples.shift();
  }

  noteTurnStart(instanceId: string, at = Date.now()): void { this.takeState(instanceId).turnStartedAt = at; }

  resetBaseline(instanceId: string): void {
    const state = this.takeState(instanceId);
    state.previous = undefined; state.samples = []; state.configEvents = []; state.afterCompaction = true;
  }

  private recordMiss(state: InstanceCacheState, current: CacheMissSample & { ttlMs?: number; provider?: string }): void {
    // The first request after compaction is an expected rewrite, not waste.
    const previous = state.afterCompaction ? { promptTokens: current.promptTokens, at: current.at } : state.previous;
    const notes = state.configEvents.filter(e => e.at <= current.at && current.at - e.at <= CAUSE_CORRELATION_WINDOW_MS).map(e => e.kind);
    if (state.afterCompaction) notes.push('after compaction');
    const miss = assessCacheMiss(previous, { ...current, at: state.turnStartedAt ?? current.at }, notes, current.ttlMs);
    if (miss) {
      const price = current.model && hasModelRate(current.model) ? miss.missedTokens * getModelRate(current.model).input / 1e6
        * ((current.provider === 'claude' && current.ttlMs === 3600000 ? 2 : getCacheWriteMultiplier(current.model)) - getCacheReadMultiplier(current.model)) : undefined;
      if (miss.cause === 'after compaction') state.expectedRewriteTokens += miss.missedTokens;
      else {
        state.rewriteTokens += miss.missedTokens; state.rewriteCostUsd += price ?? 0;
        state.hasUnpricedRewrite ||= price === undefined;
        state.rewriteIsEstimated ||= current.exact === false;
      }
      state.lastBreak = { at: current.at, ratio: (current.cacheRead ?? 0) / current.promptTokens, trailingMedian: 0,
        ...miss, ...(price !== undefined ? { extraCostUsd: price } : {}), probableCause: miss.cause };
    }
    state.previous = { ...current };
    state.afterCompaction = false; state.turnStartedAt = undefined;
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
      return { instanceId, samples: [], rewriteTokens: 0, rewriteCostUsd: 0, expectedRewriteTokens: 0 };
    }
    return {
      instanceId,
      samples: state.samples.slice(-REPORT_SAMPLE_LIMIT),
      rewriteTokens: state.rewriteTokens, expectedRewriteTokens: state.expectedRewriteTokens,
      rewriteIsEstimated: state.rewriteIsEstimated,
      ...(!state.hasUnpricedRewrite ? { rewriteCostUsd: state.rewriteCostUsd } : {}),
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
      state = { samples: [], configEvents: [], rewriteTokens: 0, rewriteCostUsd: 0, expectedRewriteTokens: 0,
        hasUnpricedRewrite: false, rewriteIsEstimated: false, accountedCallIds: new Set<string>() };
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
