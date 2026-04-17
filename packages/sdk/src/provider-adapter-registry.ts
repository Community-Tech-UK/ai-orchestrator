import type { ProviderConfig } from '@shared/types/provider.types';
import type { ProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';

export interface ProviderAdapterDescriptor {
  readonly provider: ProviderName;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly defaultConfig: ProviderConfig;
}

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export interface ProviderAdapterRegistry {
  list(): readonly ProviderAdapterDescriptor[];
  get(provider: ProviderName): ProviderAdapterDescriptor;
  create(provider: ProviderName, config: ProviderConfig): ProviderAdapter;
  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void;
}
