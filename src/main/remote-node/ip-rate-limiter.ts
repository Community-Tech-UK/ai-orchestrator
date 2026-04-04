export interface RateLimitConfig {
  windowMs: number;
  maxAttemptsPerIp: number;
  baseBanMs: number;
  maxBanMs: number;
}

interface IpState {
  hits: number[];
  bannedUntil: number;
  strikes: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxAttemptsPerIp: 20,
  baseBanMs: 120_000,
  maxBanMs: 15 * 60_000,
};

export class IpRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly state = new Map<string, IpState>();

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  allowConnection(ip: string, now = Date.now()): { ok: boolean; retryAfterMs?: number } {
    const s = this.state.get(ip) ?? { hits: [], bannedUntil: 0, strikes: 0 };

    if (now < s.bannedUntil) {
      this.state.set(ip, s);
      return { ok: false, retryAfterMs: s.bannedUntil - now };
    }

    s.hits = s.hits.filter((t) => now - t < this.config.windowMs);
    s.hits.push(now);

    if (s.hits.length > this.config.maxAttemptsPerIp) {
      s.strikes += 1;
      const banMs = Math.min(
        this.config.baseBanMs * 2 ** (s.strikes - 1),
        this.config.maxBanMs,
      );
      s.bannedUntil = now + banMs;
      s.hits = [];
      this.state.set(ip, s);
      return { ok: false, retryAfterMs: banMs };
    }

    this.state.set(ip, s);
    return { ok: true };
  }

  clear(): void {
    this.state.clear();
  }
}
