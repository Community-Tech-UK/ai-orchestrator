import { describe, expect, it } from 'vitest';
import {
  ProviderIdSchema,
  QuotaGetAllPayloadSchema,
  QuotaGetProviderPayloadSchema,
  QuotaRefreshPayloadSchema,
  QuotaRefreshAllPayloadSchema,
  QuotaSetPollIntervalPayloadSchema,
  ProviderQuotaWindowSchema,
} from '../quota.schemas';

describe('ProviderIdSchema', () => {
  it('accepts the five supported providers', () => {
    for (const p of ['claude', 'codex', 'gemini', 'copilot', 'cursor'] as const) {
      expect(ProviderIdSchema.safeParse(p).success).toBe(true);
    }
  });

  it('rejects unknown providers', () => {
    expect(ProviderIdSchema.safeParse('ollama').success).toBe(false);
    expect(ProviderIdSchema.safeParse('').success).toBe(false);
    expect(ProviderIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('QuotaGetAllPayloadSchema', () => {
  it('accepts an empty payload (optional)', () => {
    expect(QuotaGetAllPayloadSchema.safeParse(undefined).success).toBe(true);
  });

  it('accepts an auth-token-only payload', () => {
    expect(QuotaGetAllPayloadSchema.safeParse({ ipcAuthToken: 'tok' }).success).toBe(true);
  });
});

describe('QuotaGetProviderPayloadSchema', () => {
  it('requires a provider', () => {
    expect(QuotaGetProviderPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a valid provider', () => {
    const r = QuotaGetProviderPayloadSchema.safeParse({ provider: 'claude' });
    expect(r.success).toBe(true);
  });
});

describe('QuotaRefreshPayloadSchema', () => {
  it('accepts a valid refresh request', () => {
    expect(
      QuotaRefreshPayloadSchema.safeParse({ provider: 'codex', ipcAuthToken: 'x' }).success,
    ).toBe(true);
  });

  it('rejects an unknown provider', () => {
    expect(QuotaRefreshPayloadSchema.safeParse({ provider: 'foo' }).success).toBe(false);
  });
});

describe('QuotaRefreshAllPayloadSchema', () => {
  it('accepts undefined (optional)', () => {
    expect(QuotaRefreshAllPayloadSchema.safeParse(undefined).success).toBe(true);
  });
});

describe('QuotaSetPollIntervalPayloadSchema', () => {
  it('accepts 0 (disabled)', () => {
    expect(
      QuotaSetPollIntervalPayloadSchema.safeParse({
        provider: 'claude',
        intervalMs: 0,
      }).success,
    ).toBe(true);
  });

  it('accepts a positive integer interval', () => {
    expect(
      QuotaSetPollIntervalPayloadSchema.safeParse({
        provider: 'claude',
        intervalMs: 15 * 60 * 1000,
      }).success,
    ).toBe(true);
  });

  it('rejects negative intervals', () => {
    expect(
      QuotaSetPollIntervalPayloadSchema.safeParse({
        provider: 'claude',
        intervalMs: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects intervals over 1 day', () => {
    expect(
      QuotaSetPollIntervalPayloadSchema.safeParse({
        provider: 'claude',
        intervalMs: 25 * 60 * 60 * 1000,
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer intervals', () => {
    expect(
      QuotaSetPollIntervalPayloadSchema.safeParse({
        provider: 'claude',
        intervalMs: 1.5,
      }).success,
    ).toBe(false);
  });
});

describe('ProviderQuotaWindowSchema', () => {
  const base = {
    kind: 'calendar-period' as const,
    id: 'cursor.included',
    label: 'Included usage',
    unit: 'percent' as const,
    used: 42,
    limit: 100,
    remaining: 58,
    resetsAt: 1_780_000_000_000,
  };

  // Regression: this schema gates QUOTA_UPDATED on its way to the renderer and
  // is `.strict()`, so a probe field the schema does not know about is not a
  // type error — it silently blocks the whole event and the quota UI goes
  // stale. Cursor and Grok publish percent windows with an `overage` flag.
  it('accepts percent-denominated windows carrying an overage flag', () => {
    expect(ProviderQuotaWindowSchema.safeParse(base).success).toBe(true);
    expect(ProviderQuotaWindowSchema.safeParse({ ...base, overage: false }).success).toBe(true);
    expect(ProviderQuotaWindowSchema.safeParse({ ...base, overage: true }).success).toBe(true);
  });

  it('still accepts the pre-existing units', () => {
    for (const unit of ['requests', 'messages', 'tokens', 'usd'] as const) {
      expect(ProviderQuotaWindowSchema.safeParse({ ...base, unit }).success).toBe(true);
    }
  });

  it('rejects an unknown unit and unknown extra keys', () => {
    expect(ProviderQuotaWindowSchema.safeParse({ ...base, unit: 'credits' }).success).toBe(false);
    expect(ProviderQuotaWindowSchema.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });
});
