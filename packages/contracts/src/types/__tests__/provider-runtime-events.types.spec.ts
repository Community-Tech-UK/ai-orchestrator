import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderRuntimeEventEnvelope,
  ProviderName,
} from '@contracts/types/provider-runtime-events';

describe('ProviderRuntimeEventEnvelope shape', () => {
  it('has eventId, seq, numeric timestamp, and typed provider', () => {
    const env: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      seq: 0,
      timestamp: 1713340800000,
      provider: 'claude',
      instanceId: 'i-1',
      event: { kind: 'status', status: 'busy' },
    };
    expectTypeOf(env.eventId).toEqualTypeOf<string>();
    expectTypeOf(env.seq).toEqualTypeOf<number>();
    expectTypeOf(env.timestamp).toEqualTypeOf<number>();
    expectTypeOf(env.provider).toEqualTypeOf<ProviderName>();
  });
});
