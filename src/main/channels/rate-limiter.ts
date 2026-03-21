export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  tryAcquire(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.getWindow(senderId);
    const windowStart = now - this.config.windowMs;

    const valid = timestamps.filter(t => t > windowStart);
    this.windows.set(senderId, valid);

    if (valid.length >= this.config.maxRequests) {
      return false;
    }

    valid.push(now);
    return true;
  }

  getRetryAfterMs(senderId: string): number {
    const timestamps = this.getWindow(senderId);
    if (timestamps.length === 0) return 0;

    const oldest = timestamps[0];
    const expiresAt = oldest + this.config.windowMs;
    return Math.max(0, expiresAt - Date.now());
  }

  reset(senderId: string): void {
    this.windows.delete(senderId);
  }

  private getWindow(senderId: string): number[] {
    if (!this.windows.has(senderId)) {
      this.windows.set(senderId, []);
    }
    return this.windows.get(senderId)!;
  }
}
