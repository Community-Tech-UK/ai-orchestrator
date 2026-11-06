import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCodeAdapter } from './opencode-adapter-factory';
import { normalizeOpenCodeNativeConfig } from './opencode-v2-config';
import { projectOpenCodeConfig } from './opencode-config-shapes';
import { _resetOpenCodeNativeModelLimitsForTesting } from './opencode-native-model-limits';

/**
 * A#61 factory specs through the **real** catalog reader (verifier round 4's
 * direction: earlier cases mocked `readOpenCodeNativeModelLimits` and so could
 * not see that the reader queried `models --verbose` through the session
 * overlay). Only the CLI boundary is faked: `runOpenCodeCapture` simulates
 * OpenCode 1.19.4's proven merge behaviour — the model listing reports the
 * registry's `limit` overlaid with any `limit` from `OPENCODE_CONFIG_CONTENT` —
 * so a reader that asks through the session overlay still sees the ceiling
 * where the real CLI would report it.
 */
const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  capture: vi.fn(),
  prepare: vi.fn(),
  launch: { command: 'opencode', major: 1 },
}));
vi.mock('./opencode-effective-budget-config', () => ({
  readOpenCodeEffectiveBudgetConfig: mocks.probe,
  runOpenCodeCapture: mocks.capture,
}));
vi.mock('./opencode-cli-launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencode-cli-launch')>();
  return { ...actual, selectOpenCodeLaunch: async () => mocks.launch };
});
vi.mock('./opencode-child-progress-source', () => ({ createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: mocks.prepare }) }));

const REGISTRY = { context: 128_000, output: 16_384 };

/** The real CLI's listing merge: overlay model `limit` fields win over the registry. */
const fakeCatalogCli = async (params: { args: readonly string[]; env: Record<string, string | undefined> }) => {
  const config = JSON.parse(params.env['OPENCODE_CONFIG_CONTENT'] ?? '{}') as Record<string, unknown>;
  const v2 = params.args[0] === 'api';
  const tree = (v2 ? config['providers'] : config['provider']) as Record<string, unknown> | undefined;
  const override = (tree?.['openai'] as Record<string, unknown> | undefined)?.['models'] as Record<string, unknown> | undefined;
  const limit = { ...REGISTRY, ...((override?.['gpt-4o'] as Record<string, unknown> | undefined)?.['limit'] as Record<string, number> | undefined) };
  return v2
    ? { code: 0, stdout: JSON.stringify({ data: [{ providerID: 'openai', modelID: 'gpt-4o', enabled: true, capabilities: { tools: true }, limit }] }) }
    : { code: 0, stdout: `openai/gpt-4o\n${JSON.stringify({ id: 'gpt-4o', providerID: 'openai', limit })}\n` };
};

interface SpawnConfig {
  prepareSpawn: () => Promise<() => void>;
  env: Record<string, string>;
}
const limitOf = (content: string): Record<string, unknown> | undefined => {
  const config = JSON.parse(content) as Record<string, unknown>;
  for (const key of ['provider', 'providers'] as const) {
    const tree = config[key] as Record<string, unknown> | undefined;
    const model = (tree?.['openai'] as Record<string, unknown> | undefined)?.['models'] as Record<string, unknown> | undefined;
    const entry = model?.['gpt-4o'] as Record<string, unknown> | undefined;
    if (entry) return entry['limit'] as Record<string, unknown>;
  }
  return undefined;
};

describe('OpenCode context ceiling through the real native catalog reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOpenCodeNativeModelLimitsForTesting();
    mocks.capture.mockImplementation(fakeCatalogCli);
    mocks.launch.command = 'opencode';
    mocks.launch.major = 1;
    mocks.prepare.mockResolvedValue(() => undefined);
    mocks.probe.mockImplementation(async (params: { env: Record<string, string>; model?: string }) => projectOpenCodeConfig(
      mocks.launch.major === 2
        ? normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env['OPENCODE_CONFIG_CONTENT']) }])
        : JSON.parse(params.env['OPENCODE_CONFIG_CONTENT']),
      params.model,
    ));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { major: 1 as const, tree: 'provider', args: ['models', 'openai', '--verbose'] },
    { major: 2 as const, tree: 'providers', args: ['api', '--standalone', 'GET', '/api/model'] },
    { major: 2 as const, tree: 'provider', args: ['api', '--standalone', 'GET', '/api/model'] },
  ])('never raises the native window to the ceiling written by its own early pass (OpenCode $major)', async ({ major, tree, args }) => {
    mocks.launch.major = major;
    // The early best-effort pass knows no window (the overlay carries only the
    // output cap) and writes `limit.context = 250000`; reading the catalog
    // through that overlay would report 250000 as the native window and keep
    // it, raising the model's real 128000-token window (verifier round 4).
    const overlay = JSON.stringify({ [tree]: { openai: { models: { 'gpt-4o': { limit: { output: 16_384 } } } } } });
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 250_000,
      env: { OPENCODE_CONFIG_CONTENT: overlay } });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(mocks.capture).toHaveBeenCalledWith(expect.objectContaining({ args }));
    if (major === 2) {
      const catalogConfig = JSON.parse(mocks.capture.mock.calls[0]![0].env['OPENCODE_CONFIG_CONTENT']);
      expect(catalogConfig).toHaveProperty('providers.openai.models.gpt-4o');
      expect(catalogConfig).not.toHaveProperty('provider');
    }
    expect(limitOf(config.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ context: 128_000, output: 16_384 });
  });

  it('keeps one session\'s ceiling out of a later session\'s native window', async () => {
    const overlay = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': { limit: { output: 16_384 } } } } } });
    const first = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 250_000,
      env: { OPENCODE_CONFIG_CONTENT: overlay } });
    await (first as unknown as { acpConfig: SpawnConfig }).acpConfig.prepareSpawn();
    const second = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 250_000 });
    const config = (second as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(limitOf(config.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ context: 128_000, output: 16_384 });
  });

  it('still clamps a higher native window down to the ceiling', async () => {
    const overlay = JSON.stringify({ provider: { openai: { models: { 'gpt-4o': { limit: { output: 16_384 } } } } } });
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 100_000,
      env: { OPENCODE_CONFIG_CONTENT: overlay } });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(limitOf(config.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ context: 100_000, output: 16_384 });
  });

  it.each([100_000, 250_000])('emits native v2 settings for a built-in model with no provider overlay (ceiling %s)', async (ceiling) => {
    mocks.launch.major = 2;
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: ceiling });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    const emitted = JSON.parse(config.env['OPENCODE_CONFIG_CONTENT']!);
    expect(emitted).not.toHaveProperty('provider');
    expect(emitted.providers.openai.models['gpt-4o'].limit).toEqual({
      context: ceiling === 100_000 ? 100_000 : 128_000, output: 16_384,
    });
    const finalProbe = JSON.parse(mocks.probe.mock.calls.at(-1)![0].env['OPENCODE_CONFIG_CONTENT']);
    expect(finalProbe).toEqual(emitted);
  });

  it('queries the v2 catalog with freshly serialized generation settings and hardened roots', async () => {
    mocks.launch.major = 2;
    mocks.launch.command = '/fixture/opencode2';
    mocks.capture.mockResolvedValue({ code: 0, stdout: JSON.stringify({ data: [{
      providerID: 'xiaomi-token-plan', modelID: 'mimo-v2.6-pro', enabled: true,
      capabilities: { tools: true }, limit: { context: 1_000_000, output: 32_000 },
    }] }) });
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'xiaomi-token-plan/mimo-v2.6-pro', contextCeilingTokens: 100_000,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { 'xiaomi-token-plan': { models: { 'mimo-v2.6-pro': {
        body: { max_completion_tokens: 8192, keep: true }, limit: { context: 1_000_000, output: 32_000 },
        variants: [{ id: 'high', settings: { reasoningEffort: 'high' }, body: { max_completion_tokens: 512 } }],
      } } } } }) },
    });
    adapter.configureHardenedMode({ writableRoots: ['/tmp/granted'] });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    const query = mocks.capture.mock.calls[0]![0];
    expect(query).toMatchObject({ command: '/fixture/opencode2', workingDirectory: '/tmp', writableRoots: ['/tmp/granted'],
      args: ['api', '--standalone', 'GET', '/api/model'] });
    const catalogConfig = JSON.parse(query.env['OPENCODE_CONFIG_CONTENT']);
    expect(catalogConfig).not.toHaveProperty('provider');
    expect(catalogConfig).not.toHaveProperty('permission');
    expect(catalogConfig.providers['xiaomi-token-plan'].models['mimo-v2.6-pro']).toMatchObject({
      body: { max_completion_tokens: 512, keep: true },
      variants: [{ id: 'high', settings: { reasoningEffort: 'high' }, body: { max_completion_tokens: 512 } }],
    });
    expect(catalogConfig.providers['xiaomi-token-plan'].models['mimo-v2.6-pro']).not.toHaveProperty('limit');
    expect(JSON.parse(config.env['OPENCODE_CONFIG_CONTENT']!).providers['xiaomi-token-plan'].models['mimo-v2.6-pro'].limit)
      .toEqual({ context: 100_000, output: 512, input: 140_000 });
  });

  it.each([1, 2])('leaves a zero-ceiling session on its native window without a catalog read (OpenCode %s)', async (major) => {
    mocks.launch.major = major;
    const tree = major === 2 ? 'providers' : 'provider';
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 0,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ [tree]: { openai: { models: { 'gpt-4o': { limit: REGISTRY } } } } }) },
    });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(limitOf(config.env['OPENCODE_CONFIG_CONTENT']!)).toEqual({ context: 128_000, output: 16_384 });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.probe.mock.calls.every(([params]) => params.model === undefined)).toBe(true);
  });

  it.each([1, 2])('prepares the session without an invalid partial limit when the catalog has no output cap (OpenCode %s)', async (major) => {
    mocks.launch.major = major;
    mocks.capture.mockResolvedValue({ code: 0, stdout: major === 2
      ? JSON.stringify({ data: [{ providerID: 'openai', modelID: 'gpt-4o', enabled: true, capabilities: { tools: true }, limit: { context: 128_000, output: 0 } }] })
      : 'openai/gpt-4o\n{"id":"gpt-4o","providerID":"openai","limit":{"context":128000,"output":0}}\n',
    });
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model: 'openai/gpt-4o', contextCeilingTokens: 100_000 });
    const config = (adapter as unknown as { acpConfig: SpawnConfig }).acpConfig;
    await config.prepareSpawn();
    expect(limitOf(config.env['OPENCODE_CONFIG_CONTENT']!)).toBeUndefined();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
});
