import { describe, it, expect, beforeEach } from 'vitest';
import { ProviderAdapterRegistryImpl } from '../provider-adapter-registry';
import { registerBuiltInProviders } from '../register-built-in-providers';
import type { ProviderConfig } from '@shared/types/provider.types';

describe('registerBuiltInProviders', () => {
  let registry: ProviderAdapterRegistryImpl;
  beforeEach(() => { registry = new ProviderAdapterRegistryImpl(); });

  it('registers all five built-in adapters', () => {
    registerBuiltInProviders(registry);
    expect(registry.list().map(d => d.provider).sort()).toEqual(['claude', 'codex', 'copilot', 'cursor', 'gemini']);
  });

  it('creating an adapter returns an instance that implements ProviderAdapter', () => {
    registerBuiltInProviders(registry);
    const cfg: ProviderConfig = { type: 'claude-cli', name: 'test', enabled: true };
    const adapter = registry.create('claude', cfg);
    expect(adapter.provider).toBe('claude');
    expect(adapter.events$).toBeDefined();
  });
});
