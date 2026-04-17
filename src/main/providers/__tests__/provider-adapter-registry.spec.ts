import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderAdapterRegistryImpl } from '../provider-adapter-registry';
import type { ProviderAdapterDescriptor, ProviderAdapterFactory } from '@sdk/provider-adapter-registry';
import type { ProviderAdapter } from '@sdk/provider-adapter';

const fakeDescriptor: ProviderAdapterDescriptor = {
  provider: 'claude',
  displayName: 'Claude Test',
  capabilities: { interruption: true, permissionPrompts: true, sessionResume: true, streamingOutput: true, usageReporting: true, subAgents: true },
  defaultConfig: { type: 'claude-cli', name: 'test', enabled: true },
};
const fakeAdapter = {} as ProviderAdapter;
const fakeFactory: ProviderAdapterFactory = () => fakeAdapter;

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
});
