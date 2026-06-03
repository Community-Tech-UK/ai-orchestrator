/**
 * IdempotencyStore — at-most-once delivery for control commands (B2).
 *
 * Mobile/HTTP and IPC clients may retry a command after a network hiccup. For
 * mutating control verbs (input / respond / interrupt / terminate) a duplicate
 * delivery must NOT execute twice — a retried `terminate` or a double-sent
 * `input` is a real bug. A client attaches a stable `idempotencyKey` to a
 * logical command; the first delivery is processed and the key recorded, and
 * any later delivery of the same key within the TTL is reported as a duplicate
 * and skipped by the handler.
 *
 * In-memory + TTL-bounded: keys are control-plane and short-lived, so there is
 * no need to persist them. Keys are composed by the caller as
 * `<verb>:<instanceId>:<clientKey>` so the same client key cannot collide
 * across different verbs or instances.
 */

const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes

export class IdempotencyStore {
  private readonly seen = new Map<string, number>(); // key -> expiresAt
  private lastSweep = 0;

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Records the key and returns whether it was ALREADY seen (i.e. this delivery
   * is a duplicate the caller should skip). First sight returns false and marks
   * the key; subsequent sights within the TTL return true.
   */
  isDuplicate(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > t) {
      return true;
    }
    this.seen.set(key, t + this.ttlMs);
    return false;
  }

  /** Compose a collision-safe key from verb + instance + the client's key. */
  static compose(verb: string, instanceId: string, clientKey: string): string {
    return `${verb}:${instanceId}:${clientKey}`;
  }

  /** Drop expired entries. Amortised: sweeps at most once per TTL window. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.ttlMs) return;
    this.lastSweep = t;
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= t) this.seen.delete(key);
    }
  }

  /** Test helper. */
  _sizeForTesting(): number {
    return this.seen.size;
  }
}

let singleton: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!singleton) singleton = new IdempotencyStore();
  return singleton;
}

export function _resetIdempotencyStoreForTesting(): void {
  singleton = null;
}
