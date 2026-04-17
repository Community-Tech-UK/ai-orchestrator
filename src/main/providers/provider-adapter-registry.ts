/**
 * Provider Adapter Registry - Concrete implementation of the SDK registry
 * contract plus a process-wide singleton for main-process bootstrap to
 * register built-in providers on.
 */

import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
} from '@sdk/provider-adapter-registry';

export class ProviderAdapterRegistryImpl implements ProviderAdapterRegistry {
  private readonly descriptors = new Map<ProviderName, ProviderAdapterDescriptor>();
  private readonly factories = new Map<ProviderName, ProviderAdapterFactory>();

  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void {
    if (this.descriptors.has(descriptor.provider)) {
      throw new Error(`Provider ${descriptor.provider} already registered`);
    }
    this.descriptors.set(descriptor.provider, descriptor);
    this.factories.set(descriptor.provider, factory);
  }

  list(): readonly ProviderAdapterDescriptor[] {
    return Object.freeze([...this.descriptors.values()]);
  }

  get(provider: ProviderName): ProviderAdapterDescriptor {
    const descriptor = this.descriptors.get(provider);
    if (!descriptor) throw new Error(`Provider ${provider} not registered`);
    return descriptor;
  }

  create(provider: ProviderName, config: ProviderConfig): ProviderAdapter {
    const factory = this.factories.get(provider);
    if (!factory) throw new Error(`Provider ${provider} not registered`);
    return factory(config);
  }
}

/** Process-wide singleton — main-process bootstrap registers built-ins on this. */
export const providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistryImpl();
