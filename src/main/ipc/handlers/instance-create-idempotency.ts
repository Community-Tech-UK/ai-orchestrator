/**
 * At-most-once session creation for `INSTANCE_CREATE_WITH_MESSAGE`.
 *
 * The renderer retries a submission when an acknowledgement is slow or lost.
 * `IdempotencyStore` on its own only answers "have I seen this key?", which is
 * enough for `sendInput` (the caller just needs `success: true`) but not for a
 * create: the retry has to come back with the *same* instance id, or the
 * renderer either spawns a duplicate session or resolves with nothing usable.
 *
 * So this keeps the in-flight/settled response per key. A duplicate awaits the
 * original promise and receives its exact response.
 */

import type { IpcResponse } from '../../../shared/types/ipc.types';

const DEFAULT_TTL_MS = 10 * 60_000;

interface CachedCreate {
  response: Promise<IpcResponse>;
  expiresAt: number;
}

export class InstanceCreateIdempotencyCache {
  private readonly entries = new Map<string, CachedCreate>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Returns the cached response for `key` when this is a duplicate delivery,
   * otherwise registers `run()` and returns its promise.
   *
   * A rejected/failed create is evicted so a genuine retry after a real failure
   * is allowed to try again rather than replaying the failure forever.
   */
  run(key: string, run: () => Promise<IpcResponse>): Promise<IpcResponse> {
    this.sweep();

    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) {
      return existing.response;
    }

    const response = run().then((result) => {
      if (!result.success) {
        this.entries.delete(key);
      }
      return result;
    }).catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });

    this.entries.set(key, { response, expiresAt: this.now() + this.ttlMs });
    return response;
  }

  /** True when `key` already has a live entry. Used only for logging. */
  has(key: string): boolean {
    const existing = this.entries.get(key);
    return !!existing && existing.expiresAt > this.now();
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= t) this.entries.delete(key);
    }
  }

  _sizeForTesting(): number {
    return this.entries.size;
  }
}

let singleton: InstanceCreateIdempotencyCache | null = null;

export function getInstanceCreateIdempotencyCache(): InstanceCreateIdempotencyCache {
  if (!singleton) singleton = new InstanceCreateIdempotencyCache();
  return singleton;
}

export function _resetInstanceCreateIdempotencyCacheForTesting(): void {
  singleton = null;
}
