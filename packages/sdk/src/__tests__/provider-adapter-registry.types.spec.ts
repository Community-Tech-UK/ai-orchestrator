import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
  ProviderAdapterPluginApi,
  PluginProviderAdapterDescriptor,
  PluginProviderId,
} from '@sdk/provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type { ProviderConfig } from '@shared/types/provider.types';

describe('ProviderAdapterRegistry types', () => {
  it('registry has list / get / create / register', () => {
    type R = ProviderAdapterRegistry;
    expectTypeOf<R['list']>().returns.toEqualTypeOf<readonly ProviderAdapterDescriptor[]>();
    expectTypeOf<R['create']>().parameters.toEqualTypeOf<[
      ProviderAdapterDescriptor['provider'],
      ProviderConfig,
    ]>();
    expectTypeOf<R['create']>().returns.toEqualTypeOf<ProviderAdapter>();
  });

  it('factory is (config) => ProviderAdapter', () => {
    expectTypeOf<ProviderAdapterFactory>().parameters.toEqualTypeOf<[ProviderConfig]>();
    expectTypeOf<ProviderAdapterFactory>().returns.toEqualTypeOf<ProviderAdapter>();
  });

  it('plugin provider descriptors are worker-isolated and plugin-namespaced', () => {
    const descriptor: PluginProviderAdapterDescriptor = {
      provider: 'plugin:acme-cli',
      displayName: 'Acme CLI',
      capabilities: {
        interruption: true,
        permissionPrompts: false,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: false,
        subAgents: false,
      },
      defaultConfig: {
        type: 'openai-compatible',
        name: 'Acme CLI',
        enabled: true,
      },
      isolation: 'worker',
    };

    expectTypeOf(descriptor.provider).toEqualTypeOf<PluginProviderId>();
    expectTypeOf(descriptor.isolation).toEqualTypeOf<'worker'>();
  });

  it('plugin provider descriptors cannot use built-in provider ids', () => {
    const base = {
      displayName: 'Bad Claude',
      capabilities: {
        interruption: true,
        permissionPrompts: false,
        sessionResume: true,
        streamingOutput: true,
        usageReporting: false,
        subAgents: false,
      },
      defaultConfig: {
        type: 'openai-compatible',
        name: 'Bad Claude',
        enabled: true,
      },
      isolation: 'worker',
    } as const;

    const _valid: PluginProviderAdapterDescriptor = {
      ...base,
      provider: 'plugin:claude',
    };

    // @ts-expect-error Built-in provider ids are not valid plugin provider ids.
    const _invalid: PluginProviderAdapterDescriptor = {
      ...base,
      provider: 'claude',
    };
  });

  it('plugin API registers descriptors by factory reference', () => {
    expectTypeOf<ProviderAdapterPluginApi['registerProviderAdapter']>().parameters
      .toEqualTypeOf<[PluginProviderAdapterDescriptor, string]>();
    expectTypeOf<ProviderAdapterPluginApi['registerProviderAdapter']>().returns.toEqualTypeOf<void>();
  });
});
