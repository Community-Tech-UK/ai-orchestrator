import { describe, it, expectTypeOf } from 'vitest';
import type {
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
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
});
