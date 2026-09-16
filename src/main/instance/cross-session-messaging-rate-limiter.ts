/**
 * In-memory token-bucket rate limiter and hop-count cap for cross-session
 * messaging (spec requirement 7 — prevent unbounded loops/floods).
 *
 * Deliberately in-memory and per-process: cross-session messaging is scoped
 * to instances within one running app instance (see the spec's Non-Goals),
 * so there is no need for persisted or cross-process state here. The
 * `session_messages` audit table is the durable record; this class only
 * decides admission.
 */

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

export interface CrossSessionRateLimiterOptions {
  /** Max tokens per `(sourceId, targetId)` pair — also the refill amount per minute. */
  ratePerMinute: number;
  /** Max hops a message may cause before a further relay is rejected. */
  maxHops: number;
  now?: () => number;
}

export class CrossSessionRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: CrossSessionRateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  private bucketKey(sourceId: string, targetId: string): string {
    return `${sourceId}\u0000${targetId}`;
  }

  /** True when a hop count would exceed the configured cap and must be rejected. */
  exceedsHopCap(hopCount: number): boolean {
    return hopCount > this.options.maxHops;
  }

  /**
   * Attempts to consume one token for `(sourceId, targetId)`. Refills the
   * bucket to its full capacity once per minute elapsed since the last
   * refill (simple fixed-window refill, sufficient for this low-volume gate).
   * Returns false — and consumes nothing — when the bucket is empty.
   */
  tryConsume(sourceId: string, targetId: string): boolean {
    const key = this.bucketKey(sourceId, targetId);
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.ratePerMinute, lastRefillAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedMinutes = Math.floor((now - bucket.lastRefillAt) / 60_000);
      if (elapsedMinutes > 0) {
        bucket.tokens = this.options.ratePerMinute;
        bucket.lastRefillAt = now;
      }
    }
    if (bucket.tokens <= 0) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Test/diagnostic hook — drops all bucket state. */
  reset(): void {
    this.buckets.clear();
  }
}
