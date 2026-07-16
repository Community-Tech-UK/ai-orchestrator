import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProviderAdapterRegistryImpl } from '../provider-adapter-registry';
import type {
  PluginProviderAdapterDescriptor,
  ProviderAdapterDescriptor,
  ProviderAdapterFactory,
} from '@sdk/provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';

const fakeDescriptor: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Test',
  capabilities: { interruption: true, permissionPrompts: true, sessionResume: true, streamingOutput: true, usageReporting: true, subAgents: true },
  defaultConfig: { type: 'claude-cli', name: 'test', enabled: true },
};
const fakeAdapter = {} as ProviderAdapter;
const fakeFactory: ProviderAdapterFactory = () => fakeAdapter;
const fakePluginDescriptor: PluginProviderAdapterDescriptor = {
  provider: 'plugin:acme-cli',
  displayName: 'Acme CLI',
  capabilities: { interruption: true, permissionPrompts: false, sessionResume: true, streamingOutput: true, usageReporting: false, subAgents: false },
  defaultConfig: { type: 'openai-compatible', name: 'Acme CLI', enabled: true },
  isolation: 'worker',
};

describe('ProviderAdapterRegistryImpl', () => {
  let registry: ProviderAdapterRegistryImpl;
  beforeEach(() => { registry = new ProviderAdapterRegistryImpl(); });

  it('register adds a descriptor and factory', () => {
    registry.register(fakeDescriptor, fakeFactory);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('claude')).toBe(fakeDescriptor);
  });

  it('register throws on duplicate provider', () => {
    registry.register(fakeDescriptor, fakeFactory);
    expect(() => registry.register(fakeDescriptor, fakeFactory)).toThrow(/already registered/);
  });

  it('get throws for unknown provider', () => {
    expect(() => registry.get('codex')).toThrow(/not registered/);
  });

  it('create invokes factory with config', () => {
    registry.register(fakeDescriptor, fakeFactory);
    const cfg = { type: 'claude-cli', name: 'runtime', enabled: true } as const;
    expect(registry.create('claude', cfg)).toBe(fakeAdapter);
  });

  it('list returns a frozen snapshot', () => {
    registry.register(fakeDescriptor, fakeFactory);
    const snap = registry.list();
    expect(snap).toHaveLength(1);
    expect(() => (snap as ProviderAdapterDescriptor[]).push(fakeDescriptor)).toThrow();
  });

  it('registers plugin provider descriptors by worker factory reference', () => {
    registry.registerPluginProviderAdapter(fakePluginDescriptor, 'factory:acme');

    expect(registry.listPluginProviderAdapters()).toEqual([
      { descriptor: fakePluginDescriptor, factoryRef: 'factory:acme' },
    ]);
    expect(registry.getPluginProviderAdapter('plugin:acme-cli')).toEqual({
      descriptor: fakePluginDescriptor,
      factoryRef: 'factory:acme',
    });
  });

  it('creates plugin provider adapters through the registered host bridge', () => {
    const config = { type: 'openai-compatible', name: 'Acme Runtime', enabled: true } as const;
    const bridgedAdapter = { provider: 'plugin:acme-cli' } as unknown as ProviderAdapter;
    const bridge = {
      createProviderAdapter: vi.fn(() => bridgedAdapter),
    };
    registry.registerPluginProviderAdapter(fakePluginDescriptor, 'factory:acme', bridge);

    expect(registry.createPluginProviderAdapter('plugin:acme-cli', config)).toBe(bridgedAdapter);
    expect(bridge.createProviderAdapter).toHaveBeenCalledWith(
      fakePluginDescriptor,
      'factory:acme',
      config,
    );
  });

  it('rejects plugin provider creation when registration has no host bridge', () => {
    registry.registerPluginProviderAdapter(fakePluginDescriptor, 'factory:acme');

    expect(() => registry.createPluginProviderAdapter('plugin:acme-cli', fakePluginDescriptor.defaultConfig))
      .toThrow(/no host bridge/);
  });

  it('rejects duplicate plugin provider ids', () => {
    registry.registerPluginProviderAdapter(fakePluginDescriptor, 'factory:acme');

    expect(() => registry.registerPluginProviderAdapter(fakePluginDescriptor, 'factory:other'))
      .toThrow(/already registered/);
  });

  it('rejects plugin providers that use built-in provider ids', () => {
    const descriptor = {
      ...fakePluginDescriptor,
      provider: 'claude',
    } as unknown as PluginProviderAdapterDescriptor;

    expect(() => registry.registerPluginProviderAdapter(descriptor, 'factory:bad'))
      .toThrow(/reserved built-in provider id/);
  });

  it('rejects built-in registration through the plugin namespace', () => {
    const descriptor = {
      ...fakeDescriptor,
      provider: 'plugin:acme-cli',
    } as unknown as ProviderAdapterDescriptor;

    expect(() => registry.register(descriptor, fakeFactory))
      .toThrow(/plugin provider ids must use registerPluginProviderAdapter/);
  });
});
