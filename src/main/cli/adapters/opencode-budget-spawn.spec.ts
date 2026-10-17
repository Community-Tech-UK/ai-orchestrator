import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from './opencode-adapter-factory';
import type { OpenCodeGenerationBudget } from './opencode-generation-budget';
import { normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  prepare: vi.fn(),
  launch: { command: 'opencode', major: 1 },
}));
vi.mock('./opencode-effective-budget-config', () => ({ readOpenCodeEffectiveBudgetConfig: mocks.probe }));
vi.mock('./opencode-cli-launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencode-cli-launch')>();
  return { ...actual, selectOpenCodeLaunch: async () => mocks.launch };
});
vi.mock('./opencode-child-progress-source', () => ({ createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: mocks.prepare }) }));

interface SpawnConfig {
  prepareSpawn: () => Promise<() => void>;
  env: Record<string, string>;
  generationBudget?: OpenCodeGenerationBudget;
}
describe('OpenCode budget actual spawn preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.launch.command = 'opencode';
    mocks.launch.major = 1;
    mocks.prepare.mockResolvedValue(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  it('refuses extra folders on OpenCode 1 before any private config probe or ACP spawn', async () => {
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', additionalDirectories: ['/tmp/shared'] });
    await expect((adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn()).rejects.toThrow(/OpenCode 2/);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each([[1, 2], [2, 1]] as const)('refuses actual OpenCode %s when the session explicitly requires major %s', async (selected, required) => {
    mocks.launch.major = selected;
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(selected === 2
      ? normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }])
      : JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', nodePlacement: { requiresOpenCodeMajor: required } });
    await expect((adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn()).rejects.toThrow(`requires OpenCode ${required}`);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('refuses a native fork on a selected OpenCode 1 even if an earlier worker capability report claimed 2', async () => {
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', sessionId: 'fixture-parent-session', resume: true, forkSession: true });
    await expect((adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn()).rejects.toThrow(/fork.*OpenCode 2/i);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each([1, 2] as const)('allows an explicitly required major when the actual selected install matches %s', async (major) => {
    mocks.launch.major = major;
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(major === 2
      ? normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }])
      : JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', nodePlacement: { requiresOpenCodeMajor: major } });
    await (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('re-reads effective native limits from the original overlay on every spawn, without copying private config', async () => {
    const effective = (cap: number) => ({ provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
      options: { max_completion_tokens: cap, private: 'LOCAL_PRIVATE_BODY_PLACEHOLDER' },
      limit: { context: 800000, output: 4096 },
    } } } } });
    let probes = 0;
    mocks.probe.mockImplementation(async (params) => (++probes % 2
      ? effective(probes === 1 ? 1024 : 512)
      : projectOpenCodeConfig(JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model)));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan/mimo-v2.6-pro',
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
        options: { thinking: { type: 'enabled' }, max_completion_tokens: 4096 },
      } } } } }) },
    });
    adapter.configureHardenedMode({ writableRoots: ['/tmp/granted'] });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    for (const cap of [1024, 512]) {
      await config.prepareSpawn();
      expect(config.generationBudget?.combinedOutputTokens).toBe(cap);
      expect(JSON.parse(config.env['OPENCODE_CONFIG_CONTENT']!)).toMatchObject({ provider: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
        options: { thinking: { type: 'enabled' }, max_completion_tokens: cap }, limit: { context: 800000, output: cap },
      } } } } });
      expect(config.env['OPENCODE_CONFIG_CONTENT']).not.toContain('LOCAL_PRIVATE_BODY_PLACEHOLDER');
    }
    for (const [index, [params]] of mocks.probe.mock.calls.entries()) {
      expect(params.writableRoots).toEqual(['/tmp/granted']);
      if (index % 2 === 0) expect(JSON.parse(params.env.OPENCODE_CONFIG_CONTENT).provider['xiaomi-token-plan'].models['mimo-v2.6-pro'].options.max_completion_tokens).toBe(4096);
    }
    expect(mocks.probe).toHaveBeenCalledTimes(4);
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });
  it('probes only permission precedence for unrelated models and preserves their budgets', async () => {
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-5.4' });
    await (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn();
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(mocks.probe.mock.calls.every(([params]) => params.model === undefined)).toBe(true);
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('discovers native-only agents and verifies the final ask brake before preparing the ACP process', async () => {
    mocks.probe.mockImplementationOnce(async () => ({ agent: { custom: { permission: { 'doom_loop*': 'allow' } } } }))
      .mockImplementationOnce(async (params) => projectOpenCodeConfig(JSON.parse(params.env.OPENCODE_CONFIG_CONTENT)));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-5.4' });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(JSON.parse(config.env['OPENCODE_CONFIG_CONTENT']!)).toMatchObject({ agent: { custom: { permission: { 'doom_loop**': 'ask' } } } });
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('fails closed if managed configuration replaces the final native cap or permission', async () => {
    mocks.probe.mockResolvedValueOnce({}).mockResolvedValueOnce({ permission: { '*': 'allow' } });
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan/mimo-v2.6-pro' });
    await expect((adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn()).rejects.toThrow('doom-loop permission');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('publishes only native OpenCode 2 settings before both probes and the final spawn and skips the v1 HTTP flags', async () => {
    mocks.launch.command = '/Applications/OpenCode.app/Contents/Resources/opencode-cli';
    mocks.launch.major = 2;
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }]), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan/mimo-v2.6-pro' });
    const config = (adapter as unknown as { acpConfig: SpawnConfig; getConfig(): { command: string } });
    await config.acpConfig.prepareSpawn();
    for (const [params] of mocks.probe.mock.calls) {
      const native = JSON.parse(params.env.OPENCODE_CONFIG_CONTENT);
      expect(native).toHaveProperty('permissions');
      expect(native).not.toHaveProperty('permission');
      expect(native).not.toHaveProperty('provider');
    }
    expect(config.getConfig().command).toBe(mocks.launch.command);
    expect(JSON.parse(config.acpConfig.env['OPENCODE_CONFIG_CONTENT']!).providers['xiaomi-token-plan']
      .models['mimo-v2.6-pro'].limit.output).toBe(32000);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.any(Array), expect.any(Object), { serveHttp: false });
  });
  it('clamps existing native provider and agent body caps while retaining unrelated native models', async () => {
    mocks.launch.major = 2;
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }]), params.model));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'aio-mimo-demo/mimo-v2.6-pro',
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { 'aio-mimo-demo': { models: {
        unrelated: { limit: { output: 8192 } }, 'mimo-v2.6-pro': { body: { max_completion_tokens: 8192 }, limit: { context: 1000000, output: 32000 }, variants: [{ id: 'high', body: { max_completion_tokens: 512 } }] },
      } } }, agents: { build: { system: 'Preserve instructions', request: { body: { max_completion_tokens: 1024 } } } } }) },
    });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(config.generationBudget?.combinedOutputTokens).toBe(512);
    expect(JSON.parse(config.env['OPENCODE_CONFIG_CONTENT']!)).toMatchObject({ providers: { 'aio-mimo-demo': { models: {
      unrelated: { limit: { output: 8192 } }, 'mimo-v2.6-pro': { body: { max_completion_tokens: 512 }, variants: [{ id: 'high', body: { max_completion_tokens: 512 } }] },
    } } }, agents: { build: { system: 'Preserve instructions', request: { body: { max_completion_tokens: 512 } } } } });
  });
  it('retains inline native variant behavior through both selected-v2 probes and final spawn preparation', async () => {
    mocks.launch.major = 2;
    mocks.probe.mockImplementation(async (params) => projectOpenCodeConfig(normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }]), params.model));
    const variant = { id: 'custom', name: 'Custom effort', settings: { reasoningEffort: 'high', temperature: 0.123 }, body: { max_completion_tokens: 512, custom_flag: true } };
    const inline = { providers: { 'aio-mimo-demo': { models: { 'mimo-v2.6-pro': { variants: [variant] } } } } };
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'aio-mimo-demo/mimo-v2.6-pro', env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inline) } });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    const emitted = [...mocks.probe.mock.calls.map(([params]) => params.env.OPENCODE_CONFIG_CONTENT), config.env['OPENCODE_CONFIG_CONTENT']];
    for (const content of emitted) {
      expect(JSON.parse(content).providers['aio-mimo-demo'].models['mimo-v2.6-pro'].variants).toEqual([variant]);
    }
    expect(config.generationBudget?.combinedOutputTokens).toBe(512);
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('does not prepare an ACP server when native limits cannot be resolved', async () => {
    mocks.probe.mockRejectedValue(new Error('Native config unavailable'));
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan/mimo-v2.6-pro' });
    await expect((adapter as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn()).rejects.toThrow('Native config unavailable');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
