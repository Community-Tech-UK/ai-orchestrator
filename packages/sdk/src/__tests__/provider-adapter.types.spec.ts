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
import type { PluginProviderId } from '@sdk/provider-adapter-registry';

describe('ProviderAdapter', () => {
  it('has provider, capabilities, and events$', () => {
    type P = Pick<ProviderAdapter, 'provider' | 'capabilities' | 'events$'>;
    expectTypeOf<P['provider']>().toEqualTypeOf<ProviderName>();
    expectTypeOf<P['capabilities']>().toEqualTypeOf<ProviderAdapterCapabilities>();
    expectTypeOf<P['events$']>().toEqualTypeOf<Observable<ProviderRuntimeEventEnvelope>>();
  });

  it('allows plugin provider ids on provider adapters', () => {
    const provider = 'plugin:acme-cli' as const satisfies PluginProviderId;
    expectTypeOf(provider).toMatchTypeOf<ProviderAdapter['provider']>();
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
