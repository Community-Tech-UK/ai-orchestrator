import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = { current: '' };
const pool = { hasNonLegacy: { claude: false, codex: false, opencode: false } };
const openCodeProfiles = { current: [] as Array<{ id: string; label: string; enabled: boolean; isLegacy: boolean; region?: 'ams' | 'sgp' | 'cn' }> };
const spawnCalls: Array<{ env: NodeJS.ProcessEnv }> = [];

// Capture the merged child env at the last step before spawn, then stop: the
// test must never launch a real CLI.
class SpawnCaptured extends Error {}
vi.mock('../../cli-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli-environment')>();
  return {
    ...actual,
    buildCliSpawnOptions: vi.fn((env: NodeJS.ProcessEnv) => {
      spawnCalls.push({ env });
      throw new SpawnCaptured('captured');
    }),
  };
});

vi.mock('../adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('../adapter-spawn-helpers')>('../adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});

vi.mock('../../../providers/account-pool/provider-account-store', () => ({
  isAccountPoolActive: (provider: 'claude' | 'codex' | 'opencode') => pool.hasNonLegacy[provider],
  getProviderAccountStore: () => ({
    hasNonLegacyProfiles: (provider: 'claude' | 'codex' | 'opencode') => pool.hasNonLegacy[provider],
    getPoolPolicy: () => ({ continuation: 'replay' }),
    listProfiles: (provider: string) => (provider === 'opencode' ? openCodeProfiles.current : []),
  }),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createClaudeAdapter, createCliAdapter, createCodexAdapter, createOpenCodeAdapter } from '../adapter-factory';
import { CLAUDE_STRIPPED_AUTH_ENV_VARS, CODEX_STRIPPED_AUTH_ENV_VARS } from '../adapter-spawn-helpers';
import {
  putOpenCodeRegionModelMetadata,
  _resetOpenCodeRegionModelMetadataForTesting,
} from '../../../providers/opencode-region-model-metadata';
import { OPENCODE_CONFIG_CONTENT_ENV } from '../opencode-adapter-factory';
import { _resetHardenedModeScopingForTesting, setInstanceHardened } from '../../../instance/lifecycle/hardened-mode-scoping';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import type { ResolvedAccountRoute } from '../../../../shared/types/provider-account.types';

const AMBIENT = [...CLAUDE_STRIPPED_AUTH_ENV_VARS, ...CODEX_STRIPPED_AUTH_ENV_VARS];
const savedEnv: Record<string, string | undefined> = {};

function route(
  provider: 'claude' | 'codex' | 'opencode',
  profileId: string,
  extra: Partial<ResolvedAccountRoute> = {},
): ResolvedAccountRoute {
  return { provider, profileId, source: 'default', executionNodeId: 'local', ...extra };
}

function childEnvOf(adapter: unknown): NodeJS.ProcessEnv {
  spawnCalls.length = 0;
  expect(() => (adapter as { spawnProcess(args: string[]): unknown }).spawnProcess(['--version'])).toThrow('captured');
  expect(spawnCalls).toHaveLength(1);
  return spawnCalls[0]!.env;
}

beforeEach(() => {
  _resetHardenedModeScopingForTesting();
  _resetOpenCodeRegionModelMetadataForTesting();
  stateRoot.current = mkdtempSync(join(tmpdir(), 'factory-account-route-'));
  pool.hasNonLegacy = { claude: false, codex: false, opencode: false };
  openCodeProfiles.current = [];
  for (const key of AMBIENT) {
    savedEnv[key] = process.env[key];
    process.env[key] = `ambient-${key.toLowerCase()}`;
  }
});

afterEach(() => {
  _resetHardenedModeScopingForTesting();
  for (const key of AMBIENT) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(stateRoot.current, { recursive: true, force: true });
});

describe('createClaudeAdapter account routing', () => {
  const base: UnifiedSpawnOptions = { workingDirectory: tmpdir() };

  it('sets the exact profile CLAUDE_CONFIG_DIR and strips ambient auth for a derived route', () => {
    pool.hasNonLegacy.claude = true;
    const adapter = createClaudeAdapter({ ...base, accountRoute: route('claude', 'max-b') });
    const env = childEnvOf(adapter);
    expect(env['CLAUDE_CONFIG_DIR']).toBe(realpathSync(join(stateRoot.current, 'claude-cli-profiles', 'max-b')));
    for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS.filter((name) => name !== 'CLAUDE_CONFIG_DIR')) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it('grants a hardened derived profile its exact config home', () => {
    pool.hasNonLegacy.claude = true;
    setInstanceHardened('hardened-derived', true);
    const adapter = createCliAdapter('claude', {
      ...base,
      instanceId: 'hardened-derived',
      accountRoute: route('claude', 'max-b'),
    });
    const home = realpathSync(join(stateRoot.current, 'claude-cli-profiles', 'max-b'));
    const configured = adapter as unknown as { hardenedMode: { writableRoots: string[] } };

    expect(configured.hardenedMode.writableRoots).toContain(home);
    expect(configured.hardenedMode.writableRoots).not.toContain(stateRoot.current);
  });

  it('keeps a caller-supplied CLAUDE_CONFIG_DIR from overriding the profile', () => {
    pool.hasNonLegacy.claude = true;
    const adapter = createClaudeAdapter({
      ...base,
      env: { CLAUDE_CONFIG_DIR: '/tmp/elsewhere', ANTHROPIC_API_KEY: 'caller-value' },
      accountRoute: route('claude', 'max-b'),
    });
    const env = childEnvOf(adapter);
    expect(env['CLAUDE_CONFIG_DIR']).not.toBe('/tmp/elsewhere');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('sets no CLAUDE_CONFIG_DIR and strips ambient auth for the legacy profile of an active pool', () => {
    pool.hasNonLegacy.claude = true;
    const env = childEnvOf(createClaudeAdapter({ ...base, accountRoute: route('claude', 'legacy') }));
    for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it('changes nothing while only the legacy profile exists (no route is attached)', () => {
    const unrouted = childEnvOf(createClaudeAdapter(base));
    expect(unrouted['CLAUDE_CONFIG_DIR']).toBe('ambient-claude_config_dir');
    expect(unrouted['ANTHROPIC_API_KEY']).toBe('ambient-anthropic_api_key');
  });

  it('strips ambient auth for a legacy route where no pool settings exist (a worker node)', () => {
    const env = childEnvOf(createClaudeAdapter({ ...base, accountRoute: route('claude', 'legacy') }));
    for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it('fails closed when a pool exists and no route was attached', () => {
    pool.hasNonLegacy.claude = true;
    expect(() => createClaudeAdapter(base)).toThrow(/without a resolved account profile/);
  });

  it('refuses --bare on a derived route', () => {
    pool.hasNonLegacy.claude = true;
    expect(() => createClaudeAdapter({ ...base, bare: true, accountRoute: route('claude', 'max-b') })).toThrow(/--bare/);
  });

  it('rejects a route for another provider', () => {
    expect(() => createClaudeAdapter({ ...base, accountRoute: route('codex', 'max-b') })).toThrow(/internal routing error/);
  });
});

describe('createCodexAdapter account routing', () => {
  const base: UnifiedSpawnOptions = { workingDirectory: tmpdir() };

  it('links auth from the profile home, pins the file store and strips ambient auth', () => {
    pool.hasNonLegacy.codex = true;
    const adapter = createCodexAdapter({ ...base, accountRoute: route('codex', 'pro-b') });
    const config = (adapter as unknown as { cliConfig: { authSourceDir?: string; configOverrides?: string[] } }).cliConfig;
    expect(config.authSourceDir).toBe(realpathSync(join(stateRoot.current, 'codex-cli-profiles', 'pro-b')));
    expect(config.configOverrides).toEqual(['cli_auth_credentials_store=file']);
    const env = childEnvOf(adapter);
    for (const key of CODEX_STRIPPED_AUTH_ENV_VARS) {
      expect(env[key], key).toBeUndefined();
    }
    const args = (adapter as unknown as { buildArgs(message: { role: string; content: string }): string[] })
      .buildArgs({ role: 'user', content: 'hi' });
    expect(args.slice(0, 3)).toEqual(['-c', 'cli_auth_credentials_store=file', 'exec']);
  });

  it('changes nothing while only the legacy profile exists (no route is attached)', () => {
    const adapter = createCodexAdapter(base);
    const config = (adapter as unknown as { cliConfig: { authSourceDir?: string; configOverrides?: string[] } }).cliConfig;
    expect(config.authSourceDir).toBeUndefined();
    expect(config.configOverrides).toBeUndefined();
    expect(childEnvOf(adapter)['OPENAI_API_KEY']).toBe('ambient-openai_api_key');
  });

  it('keeps the legacy home but strips ambient auth for a legacy route without pool settings (a worker node)', () => {
    const adapter = createCodexAdapter({ ...base, accountRoute: route('codex', 'legacy') });
    const config = (adapter as unknown as { cliConfig: { authSourceDir?: string } }).cliConfig;
    expect(config.authSourceDir).toBeUndefined();
    expect(childEnvOf(adapter)['OPENAI_API_KEY']).toBeUndefined();
  });

  it('fails closed when a pool exists and no route was attached', () => {
    pool.hasNonLegacy.codex = true;
    expect(() => createCodexAdapter(base)).toThrow(/without a resolved account profile/);
  });
});

describe('createOpenCodeAdapter account routing', () => {
  const base: UnifiedSpawnOptions = { workingDirectory: tmpdir() };

  const metaBlock = {
    providerId: 'xiaomi-token-plan-ams',
    modelId: 'mimo-v2.6-pro',
    metadata: {
      id: 'mimo-v2.6-pro',
      name: 'MiMo-V2.6-Pro',
      api: { npm: '@ai-sdk/openai-compatible', url: 'https://token-plan-ams.xiaomimimo.com/v1' },
      limit: { context: 1000000, output: 16384 },
      options: { max_completion_tokens: 16384 },
      capabilities: { reasoning: true, toolcall: true, interleaved: { field: 'reasoning_content' } },
      variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } },
    },
  };

  it('defines the aio-mimo provider with copied metadata and swaps the model prefix', () => {
    pool.hasNonLegacy.opencode = true;
    openCodeProfiles.current = [
      { id: 'max-b-1a2b', label: 'MiMo B', enabled: true, isLegacy: false, region: 'ams' },
    ];
    putOpenCodeRegionModelMetadata('ams', [metaBlock]);
    const adapter = createOpenCodeAdapter({
      ...base,
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route('opencode', 'max-b-1a2b', { region: 'ams' }),
    });
    const config = (adapter as unknown as { acpConfig: { env: Record<string, string>; sessionConfig?: { model?: string } } }).acpConfig;
    expect(config.sessionConfig?.model).toBe('aio-mimo-max-b-1a2b/mimo-v2.6-pro');
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(content.provider['aio-mimo-max-b-1a2b']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
      models: { 'mimo-v2.6-pro': { interleaved: { field: 'reasoning_content' } } },
    });
    expect(config.env[OPENCODE_CONFIG_CONTENT_ENV]).not.toContain('apiKey');
  });

  it('changes nothing while only the legacy profile exists (no route is attached)', () => {
    openCodeProfiles.current = [
      { id: 'legacy', label: 'Existing MiMo account (ams)', enabled: true, isLegacy: true, region: 'ams' },
    ];
    const adapter = createOpenCodeAdapter({
      ...base,
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
    });
    const config = (adapter as unknown as { acpConfig: { env: Record<string, string>; sessionConfig?: { model?: string } } }).acpConfig;
    expect(config.sessionConfig?.model).toBe('xiaomi-token-plan-ams/mimo-v2.6-pro');
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(Object.keys(content.provider ?? {}).filter((key: string) => key.startsWith('aio-mimo-'))).toEqual([]);
  });

  it.each(['opencode/big-pickle', 'openrouter/anthropic/claude-sonnet', 'openrouter/xiaomi/mimo-v2.6-pro', undefined, '', 'auto'])('starts %s without MiMo account config or metadata in an active pool', (model) => {
    pool.hasNonLegacy.opencode = true;
    openCodeProfiles.current = [{ id: 'b', label: 'MiMo B', enabled: true, isLegacy: false, region: 'ams' }];
    const adapter = createOpenCodeAdapter({ ...base, model });
    const config = (adapter as unknown as { acpConfig: { env: Record<string, string>; sessionConfig?: { model?: string } } }).acpConfig;
    const content = JSON.parse(config.env[OPENCODE_CONFIG_CONTENT_ENV]!);
    expect(Object.keys(content.provider ?? {}).filter((key) => key.startsWith('aio-mimo-'))).toEqual([]);
    expect(config.sessionConfig?.model).toBe(model && model !== 'auto' ? model : undefined);
  });

  it('fails closed when a pool exists and no route was attached', () => {
    pool.hasNonLegacy.opencode = true;
    openCodeProfiles.current = [
      { id: 'max-b-1a2b', label: 'MiMo B', enabled: true, isLegacy: false, region: 'ams' },
    ];
    expect(() => createOpenCodeAdapter({ ...base, model: 'xiaomi-token-plan-ams/mimo-v2.6-pro' })).toThrow(/without a resolved account profile/);
  });

  it('rejects a route for another provider', () => {
    expect(() => createOpenCodeAdapter({ ...base, model: 'xiaomi-token-plan-ams/mimo-v2.6-pro', accountRoute: route('claude', 'max-b') })).toThrow(/internal routing error/);
  });

  it('requires the account region on the route (it is what the spawn derives)', () => {
    pool.hasNonLegacy.opencode = true;
    openCodeProfiles.current = [];
    expect(() => createOpenCodeAdapter({
      ...base,
      model: 'xiaomi-token-plan-ams/mimo-v2.6-pro',
      accountRoute: route('opencode', 'max-b-1a2b'),
    })).toThrow(/no Token Plan region/);
  });
});
