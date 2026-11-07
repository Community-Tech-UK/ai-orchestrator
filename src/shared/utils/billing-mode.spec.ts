import { describe, expect, it } from 'vitest';
import { resolveBillingMode } from './billing-mode';
import { resolveCacheTtlMs } from './cache-ttl';
describe('billing mode and cache lifetime', () => {
  it('uses provider billing facts, never a subscription guess', () => {
    expect(resolveBillingMode('copilot')).toBe('credits');
    expect(resolveBillingMode('ollama')).toBe('local');
    expect(resolveBillingMode('claude', { plan: 'api', windows: [] })).toBe('api');
    expect(resolveBillingMode('claude', { windows: [{ limit: 100, unit: 'percent' }] })).toBe('plan');
    expect(resolveBillingMode('codex', undefined, { planLabel: 'Pro' })).toBe('plan');
    expect(resolveBillingMode('unknown')).toBe('unknown');
  });
  it('shares Claude plan/API and Copilot reported lifetimes and leaves unsupported providers unknown', () => {
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'plan')).toBe(3600000);
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'api')).toBe(300000);
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'unknown')).toBeUndefined();
    expect(resolveCacheTtlMs({ provider: 'copilot', currentModel: 'gpt' }, 'credits', [{ modelId: 'gpt', ttlSeconds: 1800, expiresAt: 123 }])).toBe(1800000);
    expect(resolveCacheTtlMs({ provider: 'codex' }, 'plan')).toBeUndefined();
  });
});
