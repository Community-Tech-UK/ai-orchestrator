/**
 * Sliding Window Rate Limiter
 *
 * Tracks timestamps per sender and prunes expired entries on each check.
 */

export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  check(senderId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(senderId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(senderId, timestamps);
    }

    const firstValid = timestamps.findIndex(t => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  reset(senderId: string): void {
    this.windows.delete(senderId);
  }

  clear(): void {
    this.windows.clear();
  }
}
