import { describe, expect, it } from 'vitest';
import { assertLinearSessionKeepsProvider, LINEAR_SESSION_PROVIDER_FIXED } from './linear-session-provider-guard';

describe('assertLinearSessionKeepsProvider', () => {
  it('refuses, in fixed words, a queue session that the queue marked as belonging to a Linear run', () => {
    expect(() => assertLinearSessionKeepsProvider({ metadata: { planQueueRunId: 'run', planQueueRole: 'verifier', planQueueRunKind: 'tickets' } })).toThrow(LINEAR_SESSION_PROVIDER_FIXED);
    expect(LINEAR_SESSION_PROVIDER_FIXED).not.toMatch(/[A-Z]{2,5}-\d/);
  });

  it('leaves every other session alone', () => {
    expect(() => assertLinearSessionKeepsProvider({ metadata: { planQueueRunId: 'run', planQueueRole: 'worker' } })).not.toThrow();
    expect(() => assertLinearSessionKeepsProvider({ metadata: { planQueueRunKind: 'tickets' } })).not.toThrow();
    expect(() => assertLinearSessionKeepsProvider({ metadata: { planQueueRole: 'worker', planQueueRunKind: 'plans' } })).not.toThrow();
    expect(() => assertLinearSessionKeepsProvider({ metadata: undefined })).not.toThrow();
  });
});
