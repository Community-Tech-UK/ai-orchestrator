import type { ProviderConfig } from '@shared/types/provider.types';
import type {
  BuiltInProviderName,
  PluginProviderName,
} from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter, ProviderAdapterCapabilities } from '@sdk/provider-adapter';

export type PluginProviderId = PluginProviderName;

export interface ProviderAdapterDescriptor {
  readonly provider: BuiltInProviderName;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly defaultConfig: ProviderConfig;
}

export interface PluginProviderAdapterDescriptor {
  readonly provider: PluginProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly defaultConfig: ProviderConfig;
  readonly isolation: 'worker';
}

export type ProviderAdapterFactory = (config: ProviderConfig) => ProviderAdapter;

export type PluginProviderAdapterFactory = (
  config: ProviderConfig,
) => ProviderAdapter | Promise<ProviderAdapter>;

export interface PluginProviderAdapterBridge {
  createProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
    config: ProviderConfig,
  ): ProviderAdapter;
}

export interface RegisteredPluginProviderAdapter {
  readonly descriptor: PluginProviderAdapterDescriptor;
  readonly factoryRef: string;
}

export interface ProviderAdapterRegistry {
  list(): readonly ProviderAdapterDescriptor[];
  get(provider: BuiltInProviderName): ProviderAdapterDescriptor;
  create(provider: BuiltInProviderName, config: ProviderConfig): ProviderAdapter;
  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void;
}

export interface ProviderAdapterPluginApi {
  registerProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
  ): void;
  registerProviderAdapterFactory?(
    factoryRef: string,
    factory: PluginProviderAdapterFactory,
  ): void;
}

export interface PluginProviderAdapterRegistry extends ProviderAdapterPluginApi {
  listPluginProviderAdapters(): readonly RegisteredPluginProviderAdapter[];
  listCreatablePluginProviderAdapters(): readonly RegisteredPluginProviderAdapter[];
  getPluginProviderAdapter(provider: PluginProviderId): RegisteredPluginProviderAdapter;
  hasPluginProviderAdapterBridge(provider: PluginProviderId): boolean;
  createPluginProviderAdapter(provider: PluginProviderId, config: ProviderConfig): ProviderAdapter;
  unregisterPluginProviderAdapter(provider: PluginProviderId): void;
  registerPluginProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
    bridge?: PluginProviderAdapterBridge,
  ): void;
}
