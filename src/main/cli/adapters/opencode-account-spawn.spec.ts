import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  OPENCODE_CONFIG_CONTENT_ENV,
  buildOpenCodeConfigContent,
  createOpenCodeAdapter,
  resolveOpenCodeSessionModel,
} from './opencode-adapter-factory';
import { projectOpenCodeConfig } from './opencode-config-shapes';
import {
  putOpenCodeRegionModelMetadata,
  _resetOpenCodeRegionModelMetadataForTesting,
} from '../../providers/opencode-region-model-metadata';
import type { OpenCodeModelMetadataBlock } from './opencode-account-provider-config';
import type { ProviderAccountProfile, ResolvedAccountRoute } from '../../../shared/types/provider-account.types';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  prepare: vi.fn(),
  ensure: vi.fn(async () => undefined),
  launch: { command: 'opencode', major: 1 },
  profiles: [] as ProviderAccountProfile[],
  storeThrows: false,
}));

vi.mock('./opencode-effective-budget-config', () => ({ readOpenCodeEffectiveBudgetConfig: mocks.probe }));
vi.mock('./opencode-cli-launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./opencode-cli-launch')>();
  return { ...actual, selectOpenCodeLaunch: async () => mocks.launch };
});
vi.mock('./opencode-child-progress-source', () => ({
  createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: mocks.prepare }),
}));
vi.mock('../../providers/opencode-region-model-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../providers/opencode-region-model-metadata')>();
  return { ...actual, ensureOpenCodeRegionModelMetadata: mocks.ensure };
});
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  isAccountPoolActive: () => !mocks.storeThrows && mocks.profiles.some((profile) => !profile.isLegacy),
  getProviderAccountStore: () => {
    if (mocks.storeThrows) throw new Error('no settings manager');
    return {
      hasNonLegacyProfiles: (provider: string) =>
        provider === 'opencode' && mocks.profiles.some((profile) => !profile.isLegacy),
      getPoolPolicy: () => ({ continuation: 'shared-store' }),
      listProfiles: (provider: string) =>
        provider === 'opencode' ? mocks.profiles.filter((profile) => profile.enabled) : [],
    };
  },
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const META_BLOCK: OpenCodeModelMetadataBlock = {
  providerId: 'xiaomi-token-plan-ams',
  modelId: 'mimo-v2.6-pro',
  metadata: {
    id: 'mimo-v2.6-pro',
    name: 'MiMo-V2.6-Pro',
    api: { npm: '@ai-sdk/openai-compatible', url: 'https://token-plan-ams.xiaomimimo.com/v1' },
    limit: { context: 1000000, output: 16384 },
    options: { max_completion_tokens: 16384 },
    capabilities: {
      reasoning: true,
      toolcall: true,
      attachment: true,
      temperature: true,
      interleaved: { field: 'reasoning_content' },
      input: { text: true, image: true },
      output: { text: true },
    },
    variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } },
  },
};

const profile = (overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile => ({
  id: 'max-b-1a2b',
  provider: 'opencode',
  label: 'MiMo B',
  expectedIdentity: null,
  expectedAccountKey: null,
  planLabel: null,
  priority: 1,
  enabled: true,
  automationPolicy: 'allow-routed',
  isLegacy: false,
  region: 'ams',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const route = (overrides: Partial<ResolvedAccountRoute> = {}): ResolvedAccountRoute => ({
  provider: 'opencode',
  profileId: 'max-b-1a2b',
  source: 'default',
  executionNodeId: 'local',
  region: 'ams',
  ...overrides,
});

interface SpawnConfig {
  beforeStartupGate: () => Promise<void>;
  prepareSpawn: () => Promise<() => void>;
  env: Record<string, string>;
  sessionConfig?: { model?: string };
  requireSessionModelConfirmation?: boolean;
}

const acpConfig = (adapter: unknown): SpawnConfig => (adapter as { acpConfig: SpawnConfig }).acpConfig;

beforeEach(() => {
  vi.clearAllMocks();
  _resetOpenCodeRegionModelMetadataForTesting();
  mocks.launch.command = 'opencode';
  mocks.launch.major = 1;
  mocks.prepare.mockResolvedValue(() => undefined);
  mocks.ensure.mockResolvedValue(undefined);
  mocks.storeThrows = false;
  mocks.profiles = [];
  mocks.probe.mockImplementation(async (params) =>
    projectOpenCodeConfig(JSON.parse(params.env[OPENCODE_CONFIG_CONTENT_ENV]), params.model));
});

describe('buildOpenCodeConfigContent with account providers', () => {
  it('stays byte-identical to the pre-pools output for a legacy-only setup', () => {
    const existing = JSON.stringify({ model: 'opencode/big-pickle', provider: { 'fake-x': { npm: 'x' } } });
    const withoutBlocks = buildOpenCodeConfigContent(existing, true);
    const withEmptyBlocks = buildOpenCodeConfigContent(existing, true, {});
    expect(withEmptyBlocks).toBe(withoutBlocks);
    // Today's behaviour: only the permission layer is merged in.
    const merged = JSON.parse(withoutBlocks) as Record<string, Record<string, unknown>>;
    expect(merged['model']).toBe('opencode/big-pickle');
    expect(merged['provider']).toEqual({ 'fake-x': { npm: 'x' } });
    expect(merged['permission']!['*']).toBe('allow');
    expect(merged['permission']!['doom_loop']).toBe('ask');
    expect((merged['agent']!['build'] as { permission: Record<string, string> }).permission['doom_loop']).toBe('ask');
  });

  it('keeps the permission block intact and only adds aio-mimo providers when accounts exist', () => {
    const existing = JSON.stringify({ permission: { bash: 'deny', custom_tool: 'allow' }, provider: { 'fake-x': { npm: 'x' } } });
    const merged = JSON.parse(buildOpenCodeConfigContent(existing, false, {
      'aio-mimo-max-b-1a2b': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' } },
    }));
    expect(merged.permission['custom_tool']).toBe('allow');
    expect(merged.permission['bash']).toBe('ask');
    expect(Object.keys(merged.provider).sort()).toEqual(['aio-mimo-max-b-1a2b', 'fake-x']);
    expect(merged.provider['aio-mimo-max-b-1a2b'].options.baseURL).toBe('https://token-plan-ams.xiaomimimo.com/v1');
  });
});

describe('resolveOpenCodeSessionModel account prefix swap', () => {
  it('swaps the logical region prefix for the routed account provider (Decision 4)', () => {
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan-ams/mimo-v2.6-pro', 'aio-mimo-max-b-1a2b'))
      .toBe('aio-mimo-max-b-1a2b/mimo-v2.6-pro');
  });

  it('keeps the logical id for a legacy route and for other backends', () => {
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan-ams/mimo-v2.6-pro', 'xiaomi-token-plan-ams'))
      .toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan-ams/mimo-v2.6-pro', null))
      .toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(resolveOpenCodeSessionModel('openai/gpt-5.4', 'aio-mimo-max-b-1a2b')).toBe('openai/gpt-5.4');
    expect(resolveOpenCodeSessionModel('auto', 'aio-mimo-max-b-1a2b')).toBeUndefined();
  });

  it('swaps the bare xiaomi-token-plan prefix too, but never a look-alike backend', () => {
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan/mimo-v2.6-pro', 'aio-mimo-max-b-1a2b'))
      .toBe('aio-mimo-max-b-1a2b/mimo-v2.6-pro');
    expect(resolveOpenCodeSessionModel('xiaomi-token-planning/mimo-v2.6-pro', 'aio-mimo-max-b-1a2b'))
      .toBe('xiaomi-token-planning/mimo-v2.6-pro');
    expect(resolveOpenCodeSessionModel('xiaomi-token-plan-eu/mimo-v2.6-pro', 'aio-mimo-max-b-1a2b'))
      .toBe('xiaomi-token-plan-eu/mimo-v2.6-pro');
  });
});

describe('createOpenCodeAdapter under a MiMo account route', () => {
  it('injects every enabled account definition and swaps the session model prefix', () => {
    mocks.profiles = [
      profile({ id: 'legacy', label: 'Existing MiMo account (ams)', isLegacy: true, priority: 0 }),
      profile(),
      profile({ id: 'max-c-2b3c', label: 'MiMo C', priority: 2 }),
    ];
    putOpenCodeRegionModelMetadata('ams', [META_BLOCK]);
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route(),
    });
    const config = acpConfig(adapter);
    expect(config.sessionConfig?.model).toBe('aio-mimo-max-b-1a2b/mimo-v2.6-pro');
    expect(config.requireSessionModelConfirmation).toBe(true);
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(Object.keys(content.provider).sort()).toEqual(['aio-mimo-max-b-1a2b', 'aio-mimo-max-c-2b3c']);
    expect(content.provider['aio-mimo-max-b-1a2b']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'MiMo B',
      options: { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
    });
    expect(content.provider['aio-mimo-max-b-1a2b'].models['mimo-v2.6-pro']).toMatchObject({
      limit: { context: 1000000, output: 16384 },
      reasoning: true,
      tool_call: true,
      interleaved: { field: 'reasoning_content' },
    });
    expect(config.env[OPENCODE_CONFIG_CONTENT_ENV]).not.toContain('apiKey');
  });

  it('builds the routed account from the route alone on a worker (no settings)', () => {
    mocks.storeThrows = true;
    putOpenCodeRegionModelMetadata('ams', [META_BLOCK]);
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route({ executionNodeId: 'worker', profileLabel: 'MiMo B' }),
    });
    const content = JSON.parse(acpConfig(adapter).env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(Object.keys(content.provider)).toEqual(['aio-mimo-max-b-1a2b']);
  });

  it('injects no provider block for a legacy-only setup and keeps the logical model', () => {
    mocks.profiles = [profile({ id: 'legacy', label: 'Existing MiMo account (ams)', isLegacy: true, priority: 0 })];
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route({ profileId: 'legacy' }),
    });
    const config = acpConfig(adapter);
    expect(config.sessionConfig?.model).toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    expect(config.requireSessionModelConfirmation).toBe(true);
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    // Byte-identical to today: only the generation-budget stub is written, no
    // per-account `aio-mimo-*` provider is defined.
    expect(Object.keys(content.provider ?? {}).filter((key) => key.startsWith('aio-mimo-'))).toEqual([]);
    expect(content.provider['xiaomi-token-plan-ams']).toBeDefined();
  });

  it.each(['ams', 'sgp', 'cn'] as const)('derives a legacy %s native model from the worker route alone', (region) => {
    mocks.storeThrows = true;
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan/mimo-v2.6-pro',
      accountRoute: route({ profileId: 'legacy', region, executionNodeId: 'worker' }),
    });
    const config = acpConfig(adapter);
    expect(config.sessionConfig?.model).toBe(`xiaomi-token-plan-${region}/mimo-v2.6-pro`);
    expect(config.requireSessionModelConfirmation).toBe(true);
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(Object.keys(content.provider)).toEqual([`xiaomi-token-plan-${region}`]);
    expect(content.provider[`xiaomi-token-plan-${region}`].models['mimo-v2.6-pro'].limit.output).toBe(16384);
  });

  it('refuses the spawn when the routed account region metadata cannot be read', async () => {
    mocks.profiles = [profile()];
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route(),
    });
    await expect(acpConfig(adapter).prepareSpawn()).rejects.toThrow(/no model metadata for xiaomi-token-plan-ams/);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('refuses a routed account whose region does not offer the model', async () => {
    mocks.profiles = [profile()];
    putOpenCodeRegionModelMetadata('ams', [META_BLOCK]); // has mimo-v2.6-pro, not mimo-v2-tts
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2-tts',
      accountRoute: route(),
    });
    await expect(acpConfig(adapter).prepareSpawn()).rejects.toThrow(/does not offer that model/);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('rebuilds the account blocks from metadata ensured during spawn preparation', async () => {
    mocks.profiles = [profile()];
    mocks.ensure.mockImplementation(async () => {
      putOpenCodeRegionModelMetadata('ams', [META_BLOCK]);
    });
    const adapter = createOpenCodeAdapter({
      workingDirectory: '/tmp',
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route(),
    });
    await acpConfig(adapter).beforeStartupGate();
    await acpConfig(adapter).prepareSpawn();
    const content = JSON.parse(acpConfig(adapter).env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(content.provider['aio-mimo-max-b-1a2b'].models['mimo-v2.6-pro'].limit.output).toBe(16384);
    expect(mocks.ensure).toHaveBeenCalledWith(['ams']);
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
});


it.each([undefined, 'auto', 'opencode/mimo-v2.6-flash-free', 'openrouter/example-model'])(
  'keeps unrelated startup best effort when the requested model is %s', (model) => {
    mocks.profiles = [profile()];
    const adapter = createOpenCodeAdapter({ workingDirectory: '/tmp', model, accountRoute: route() });
    expect(acpConfig(adapter).requireSessionModelConfirmation).toBeUndefined();
  },
);
