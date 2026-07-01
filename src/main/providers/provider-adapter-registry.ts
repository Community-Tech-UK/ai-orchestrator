/**
 * Provider Adapter Registry - Concrete implementation of the SDK registry
 * contract plus a process-wide singleton for main-process bootstrap to
 * register built-in providers on.
 */

import type { ProviderConfig } from '@shared/types/provider.types';
import type { BuiltInProviderName } from '@contracts/types/provider-runtime-events';
import type { ProviderAdapter } from '@sdk/provider-adapter';
import type {
  PluginProviderAdapterBridge,
  PluginProviderAdapterDescriptor,
  PluginProviderAdapterRegistry,
  PluginProviderId,
  ProviderAdapterRegistry,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
  RegisteredPluginProviderAdapter,
} from '@sdk/provider-adapter-registry';

const RESERVED_BUILT_IN_PROVIDER_IDS = new Set<string>([
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
  'anthropic-api',
  'cursor',
]);

function isPluginProviderId(provider: string): provider is PluginProviderId {
  return provider.startsWith('plugin:') && provider.length > 'plugin:'.length;
}

export class ProviderAdapterRegistryImpl implements ProviderAdapterRegistry, PluginProviderAdapterRegistry {
  private readonly descriptors = new Map<BuiltInProviderName, ProviderAdapterDescriptor>();
  private readonly factories = new Map<BuiltInProviderName, ProviderAdapterFactory>();
  private readonly pluginProviders = new Map<PluginProviderId, RegisteredPluginProviderAdapter>();
  private readonly pluginProviderBridges = new Map<PluginProviderId, PluginProviderAdapterBridge>();

  register(descriptor: ProviderAdapterDescriptor, factory: ProviderAdapterFactory): void {
    if (isPluginProviderId(descriptor.provider)) {
      throw new Error('plugin provider ids must use registerPluginProviderAdapter');
    }
    if (this.descriptors.has(descriptor.provider)) {
      throw new Error(`Provider ${descriptor.provider} already registered`);
    }
    this.descriptors.set(descriptor.provider, descriptor);
    this.factories.set(descriptor.provider, factory);
  }

  list(): readonly ProviderAdapterDescriptor[] {
    return Object.freeze([...this.descriptors.values()]);
  }

  get(provider: BuiltInProviderName): ProviderAdapterDescriptor {
    const descriptor = this.descriptors.get(provider);
    if (!descriptor) throw new Error(`Provider ${provider} not registered`);
    return descriptor;
  }

  create(provider: BuiltInProviderName, config: ProviderConfig): ProviderAdapter {
    const factory = this.factories.get(provider);
    if (!factory) throw new Error(`Provider ${provider} not registered`);
    return factory(config);
  }

  registerProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
  ): void {
    this.registerPluginProviderAdapter(descriptor, factoryRef);
  }

  registerPluginProviderAdapter(
    descriptor: PluginProviderAdapterDescriptor,
    factoryRef: string,
    bridge?: PluginProviderAdapterBridge,
  ): void {
    if (RESERVED_BUILT_IN_PROVIDER_IDS.has(descriptor.provider)) {
      throw new Error(`${descriptor.provider} is a reserved built-in provider id`);
    }
    if (!isPluginProviderId(descriptor.provider)) {
      throw new Error('plugin provider ids must use the plugin: namespace');
    }
    if (descriptor.isolation !== 'worker') {
      throw new Error('plugin provider adapters must use worker isolation');
    }
    if (this.pluginProviders.has(descriptor.provider)) {
      throw new Error(`Provider ${descriptor.provider} already registered`);
    }

    this.pluginProviders.set(descriptor.provider, {
      descriptor,
      factoryRef,
    });
    if (bridge) {
      this.pluginProviderBridges.set(descriptor.provider, bridge);
    }
  }

  listPluginProviderAdapters(): readonly RegisteredPluginProviderAdapter[] {
    return Object.freeze([...this.pluginProviders.values()]);
  }

  listCreatablePluginProviderAdapters(): readonly RegisteredPluginProviderAdapter[] {
    return Object.freeze(
      [...this.pluginProviders.values()].filter((registered) =>
        this.pluginProviderBridges.has(registered.descriptor.provider)
      ),
    );
  }

  getPluginProviderAdapter(provider: PluginProviderId): RegisteredPluginProviderAdapter {
    const registered = this.pluginProviders.get(provider);
    if (!registered) throw new Error(`Provider ${provider} not registered`);
    return registered;
  }

  hasPluginProviderAdapterBridge(provider: PluginProviderId): boolean {
    return this.pluginProviderBridges.has(provider);
  }

  createPluginProviderAdapter(provider: PluginProviderId, config: ProviderConfig): ProviderAdapter {
    const registered = this.getPluginProviderAdapter(provider);
    const bridge = this.pluginProviderBridges.get(provider);
    if (!bridge) {
      throw new Error(`Provider ${provider} has no host bridge registered`);
    }
    return bridge.createProviderAdapter(registered.descriptor, registered.factoryRef, config);
  }

  unregisterPluginProviderAdapter(provider: PluginProviderId): void {
    this.pluginProviders.delete(provider);
    this.pluginProviderBridges.delete(provider);
  }
}

/** Process-wide singleton — main-process bootstrap registers built-ins on this. */
export const providerAdapterRegistry: ProviderAdapterRegistry & PluginProviderAdapterRegistry =
  new ProviderAdapterRegistryImpl();
