/**
 * Authority lease (claude2_todo #21).
 *
 * Single-owner write authority per "lane" (e.g. a worktree path or a logical
 * resource), with TTL-based stale takeover. Lets parallel agents answer "who
 * owns this lane right now?" by construction instead of racing on a shared
 * working tree. Pure and deterministic — `now` is injectable for tests.
 *
 * Model: a lane is held by exactly one owner until it is released or its lease
 * expires (no renewal within `ttlMs`). A different owner may then *take over* a
 * stale lane. Re-acquiring as the current owner renews the lease.
 */

export const DEFAULT_LEASE_TTL_MS = 60_000;

export interface LeaseRecord {
  lane: string;
  ownerId: string;
  acquiredAt: number;
  renewedAt: number;
  ttlMs: number;
}

export interface AcquireResult {
  /** Whether the caller now holds the lane. */
  ok: boolean;
  /** The current owner after the call (the caller on success). */
  owner: string;
  /** True when the caller took over a *stale* lease previously held by another owner. */
  tookOver: boolean;
  /** When `ok` is false, the unexpired owner that blocked the acquire. */
  blockedBy?: string;
}

export class AuthorityLeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();

  private isExpired(lease: LeaseRecord, now: number): boolean {
    return now - lease.renewedAt >= lease.ttlMs;
  }

  /**
   * Attempt to acquire (or renew) the lane. Succeeds when the lane is free,
   * already owned by `ownerId`, or held by someone whose lease has expired
   * (stale takeover).
   */
  acquire(
    lane: string,
    ownerId: string,
    ttlMs: number = DEFAULT_LEASE_TTL_MS,
    now: number = Date.now(),
  ): AcquireResult {
    const existing = this.leases.get(lane);

    if (existing && existing.ownerId === ownerId && !this.isExpired(existing, now)) {
      existing.renewedAt = now;
      existing.ttlMs = ttlMs;
      return { ok: true, owner: ownerId, tookOver: false };
    }

    if (existing && existing.ownerId !== ownerId && !this.isExpired(existing, now)) {
      return { ok: false, owner: existing.ownerId, tookOver: false, blockedBy: existing.ownerId };
    }

    // Free, or expired (possibly held by another owner → takeover).
    const tookOver = Boolean(existing && existing.ownerId !== ownerId);
    this.leases.set(lane, { lane, ownerId, acquiredAt: now, renewedAt: now, ttlMs });
    return { ok: true, owner: ownerId, tookOver };
  }

  /** Renew an existing lease. Fails if the caller isn't the (unexpired) owner. */
  renew(lane: string, ownerId: string, now: number = Date.now()): boolean {
    const lease = this.leases.get(lane);
    if (!lease || lease.ownerId !== ownerId || this.isExpired(lease, now)) {
      return false;
    }
    lease.renewedAt = now;
    return true;
  }

  /** Release a lane held by `ownerId`. No-op (returns false) otherwise. */
  release(lane: string, ownerId: string): boolean {
    const lease = this.leases.get(lane);
    if (!lease || lease.ownerId !== ownerId) return false;
    this.leases.delete(lane);
    return true;
  }

  /** Current (unexpired) owner of the lane, or null if free/expired. */
  owner(lane: string, now: number = Date.now()): string | null {
    const lease = this.leases.get(lane);
    if (!lease || this.isExpired(lease, now)) return null;
    return lease.ownerId;
  }

  isHeldBy(lane: string, ownerId: string, now: number = Date.now()): boolean {
    return this.owner(lane, now) === ownerId;
  }

  /** All currently-held (unexpired) lanes. */
  activeLanes(now: number = Date.now()): LeaseRecord[] {
    return [...this.leases.values()].filter((l) => !this.isExpired(l, now));
  }

  /** Drop expired leases. Returns the number pruned. */
  prune(now: number = Date.now()): number {
    let pruned = 0;
    for (const [lane, lease] of this.leases) {
      if (this.isExpired(lease, now)) {
        this.leases.delete(lane);
        pruned++;
      }
    }
    return pruned;
  }
}
