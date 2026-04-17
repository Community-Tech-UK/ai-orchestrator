import { describe, it, expectTypeOf } from 'vitest';
import type { Observable } from 'rxjs';
import type {
  ProviderAdapter,
  ProviderAdapterCapabilities,
} from '@sdk/provider-adapter';
import type {
  ProviderName,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';

describe('ProviderAdapter', () => {
  it('has provider, capabilities, and events$', () => {
    type P = Pick<ProviderAdapter, 'provider' | 'capabilities' | 'events$'>;
    expectTypeOf<P['provider']>().toEqualTypeOf<ProviderName>();
    expectTypeOf<P['capabilities']>().toEqualTypeOf<ProviderAdapterCapabilities>();
    expectTypeOf<P['events$']>().toEqualTypeOf<Observable<ProviderRuntimeEventEnvelope>>();
  });

  it('ProviderAdapterCapabilities has all 6 flags', () => {
    const caps: ProviderAdapterCapabilities = {
      interruption: true,
      permissionPrompts: true,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: true,
    };
    expectTypeOf(caps).toEqualTypeOf<ProviderAdapterCapabilities>();
  });
});
