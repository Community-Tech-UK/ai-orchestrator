/**
 * WS8 context attribution + cache-efficiency analytics — shared contracts
 * between the main-process services and the renderer panel.
 *
 * Read-only observability: these types describe what is estimated to occupy
 * an instance's context window and how well the provider prompt cache is
 * performing. Nothing here changes what is sent to a provider.
 */

/** Sources AIO can attribute context-window occupancy to. */
export type ContextAttributionBucketKey =
  | 'instructionFiles'
  | 'mcpToolSchemas'
  | 'conversationHistory'
  | 'toolResults'
  | 'attachments'
  | 'other';

export interface ContextAttributionDetail {
  label: string;
  tokens: number;
}

export interface ContextAttributionBucket {
  key: ContextAttributionBucketKey;
  /** Estimated tokens for this source (char-heuristic family; never provider-exact). */
  tokens: number;
  /** Top contributors inside the bucket (e.g. per instruction file, per MCP server). */
  detail?: ContextAttributionDetail[];
}

export interface ContextAttributionReport {
  instanceId: string;
  computedAt: number;
  buckets: ContextAttributionBucket[];
  /**
   * The aggregate occupancy the context bar already shows, echoed so the
   * panel can render "known sources vs aggregate" without a second lookup.
   * `other` = max(0, aggregateUsed - sum(known buckets)) and is only present
   * when the aggregate is known. All bucket values are estimates; the
   * provider-owned system prompt is not observable from AIO and lands in
   * `other`.
   */
  aggregateUsed?: number;
  aggregateTotal?: number;
  aggregateIsEstimated?: boolean;
}

/** One completed turn's cache efficiency sample. */
export interface CacheTurnSample {
  at: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead / (input + cacheRead); 0 when the denominator is 0. */
  ratio: number;
}

/** A config-affecting event used to explain cache breaks. */
export interface CacheConfigEvent {
  at: number;
  kind: string;
}

export interface CacheBreakEvent {
  at: number;
  ratio: number;
  trailingMedian: number;
  /** Most recent correlated config event, e.g. "model change". */
  probableCause?: string;
}

export interface CacheAnalyticsReport {
  instanceId: string;
  /** Most recent samples, oldest first (bounded for the sparkline). */
  samples: CacheTurnSample[];
  lastBreak?: CacheBreakEvent;
}
