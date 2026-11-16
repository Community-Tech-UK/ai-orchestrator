import { describe, expect, it } from 'vitest';
import { resolveBillingMode } from './billing-mode';
describe('billing mode', () => {
  it('uses provider billing facts, never a subscription guess', () => {
    expect(resolveBillingMode('copilot')).toBe('credits');
    expect(resolveBillingMode('ollama')).toBe('local');
    expect(resolveBillingMode('claude', { plan: 'api', windows: [] })).toBe('api');
    expect(resolveBillingMode('claude', { windows: [{ limit: 100, unit: 'percent' }] })).toBe('plan');
    expect(resolveBillingMode('codex', undefined, { planLabel: 'Pro' })).toBe('plan');
    expect(resolveBillingMode('unknown')).toBe('unknown');
  });
});
