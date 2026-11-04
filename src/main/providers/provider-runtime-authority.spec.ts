import { describe, expect, it, vi, afterEach } from 'vitest';
import { ProviderRuntimeService, type ProviderRuntimeStartInput } from './provider-runtime-service';
import { ProviderRuntimeRegistry } from './provider-runtime-registry';
import { createClaudeAdapter, type CliAdapter, type UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { _setSettingsReaderForTesting } from '../cli/adapters/claude-env-pack';
import { getModelsForProvider } from '../../shared/types/provider.types';
import type { AutomationExecutionAuthority } from '../../shared/types/automation.types';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}), get: () => undefined }) }));
const authority: AutomationExecutionAuthority = { provider: 'claude', model: 'sonnet', modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false };
const options = (): UnifiedSpawnOptions => ({ automationAuthority: JSON.parse(JSON.stringify(authority)), model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
afterEach(() => _setSettingsReaderForTesting(null));

describe('saved scheduled authority at the actual provider runtime boundary', () => {
  it('suppresses higher native fallback from later global settings through the real Claude constructor and argv', () => {
    _setSettingsReaderForTesting(key => key === 'claudeFallbackModel' ? 'opus' : undefined);
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: input => createClaudeAdapter(input.options) });
    const adapter = service.createAdapter({ cliType: 'claude', options: options() });
    const args = Reflect.get(adapter, 'buildArgs').call(adapter) as string[];
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'low', '--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--fallback-model');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('refuses a saved model whose catalogue tier later rises, even after JSON restart hydration', () => {
    const native = vi.fn((_input: ProviderRuntimeStartInput) => ({}) as CliAdapter);
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: native });
    const selected = getModelsForProvider('claude').find(model => model.id === 'sonnet')!;
    const before = selected.tier;
    try {
      selected.tier = 'powerful';
      expect(() => service.createAdapter({ cliType: 'claude', options: options() })).toThrow(/model tier/);
      expect(native).not.toHaveBeenCalled();
    } finally { selected.tier = before; }
  });

  it.each([
    { model: 'opus' }, { reasoningEffort: 'high' as const }, { yoloMode: true },
    { reasoningEffort: undefined }, { model: undefined }, { yoloMode: undefined },
    { launchMode: 'interactive' as const },
  ])('refuses higher or unspecified final constructor settings %j', patch => {
    const native = vi.fn((_input: ProviderRuntimeStartInput) => ({}) as CliAdapter);
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: native });
    expect(() => service.createAdapter({ cliType: 'claude', options: { ...options(), ...patch } })).toThrow(/authority/);
    expect(native).not.toHaveBeenCalled();
  });

  it('refuses a remote transport even if final options otherwise match', () => {
    const native = vi.fn((_input: ProviderRuntimeStartInput) => ({}) as CliAdapter);
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: native });
    expect(() => service.createAdapter({ cliType: 'claude', options: options(), executionLocation: { type: 'remote', nodeId: 'worker-placeholder' } })).toThrow(/remote/);
    expect(native).not.toHaveBeenCalled();
  });

  it('still permits a lower model at the same approved effort and approval', () => {
    const native = vi.fn((_input: ProviderRuntimeStartInput) => ({}) as CliAdapter);
    const service = new ProviderRuntimeService({ registry: new ProviderRuntimeRegistry(), createAdapter: native });
    service.createAdapter({ cliType: 'claude', options: { ...options(), model: 'haiku' } });
    expect(native.mock.calls[0][0].options).toMatchObject({ model: 'haiku', fallbackModel: 'haiku', reasoningEffort: 'low', yoloMode: false });
  });
});
