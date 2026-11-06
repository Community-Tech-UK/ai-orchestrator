/**
 * Plan 13d, round 5 (W15b): `createClaudeAdapter` must hand the resolved account
 * environment to `buildClaudeMcpConfig` (`adapter-factory.ts`,
 * `buildClaudeMcpConfig(options, accountEnv)`). The native-search decision reads the
 * `settings.json` of the profile's `CLAUDE_CONFIG_DIR`, and that variable exists only
 * in `accountEnv`, never in `options.env`. Drop the argument and a profile-routed
 * session is judged against the wrong settings file, so Harness's own bridges stay
 * deferred while Claude defers them too (the double layer 13d removes).
 *
 * Runs the real factory, the real account-home resolver and the real detection. The
 * profile's `settings.json` has the shape Claude writes (`env` holds strings such as
 * `ENABLE_TOOL_SEARCH`). HOME is pointed at an empty directory so the user's real
 * `~/.claude/settings.json` can never make the outcome pass or fail.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stateRoot = { current: '' };

vi.mock('./adapter-spawn-helpers', async () => {
  const actual = await vi.importActual<typeof import('./adapter-spawn-helpers')>('./adapter-spawn-helpers');
  return { ...actual, getProviderStateRoot: () => stateRoot.current };
});
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  isAccountPoolActive: () => true,
  getProviderAccountStore: () => ({
    hasNonLegacyProfiles: () => true,
    getPoolPolicy: () => ({ continuation: 'replay' }),
    listProfiles: () => [],
  }),
}));
// The seed would link/merge from the real ~/.claude; the profile home is prepared by the test.
vi.mock('../../providers/account-pool/claude-profile-seed', () => ({ seedClaudeProfileHome: vi.fn() }));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createClaudeAdapter } from './adapter-factory';
import { buildOrchestratorToolsMcpConfig } from '../../mcp/orchestrator-tools-mcp-config';
import { buildBrowserGatewayMcpConfigJson } from '../../browser-gateway/browser-mcp-config';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV } from '../../mcp/orchestrator-mcp-deferral';
import type { UnifiedSpawnOptions } from './adapter-factory.types';

const bridge = {
  aioMcpCliPath: '/fixture/aio-mcp', socketPath: '/fixture/socket', instanceId: 'fixture',
  provider: 'claude', toolDeferral: true, exists: () => true,
};
const BROWSER_DEFERRAL_ENV = 'AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL';
const SCRUBBED_ENV = ['ENABLE_TOOL_SEARCH', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'] as const;
const saved: Record<string, string | undefined> = {};

function toolModes(adapter: unknown): { orchestrator: string | undefined; browser: string | undefined } {
  const spawnOptions = Reflect.get(adapter as object, 'spawnOptions') as { mcpConfig?: string[] };
  const servers = Object.assign(
    {}, ...(spawnOptions.mcpConfig ?? []).map((entry) => JSON.parse(entry).mcpServers),
  ) as Record<string, { env: Record<string, string> }>;
  return {
    orchestrator: servers['orchestrator']?.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV],
    browser: servers['browser-gateway']?.env[BROWSER_DEFERRAL_ENV],
  };
}

function spawnOptions(profileId: string): UnifiedSpawnOptions {
  return {
    workingDirectory: tmpdir(),
    model: 'claude-opus-4-8',
    accountRoute: { provider: 'claude', profileId, source: 'default', executionNodeId: 'local' },
    mcpConfig: [buildOrchestratorToolsMcpConfig(bridge)!, buildBrowserGatewayMcpConfigJson(bridge)!],
  };
}

function writeProfileSettings(profileId: string, settings: Record<string, unknown>): void {
  const home = join(stateRoot.current, 'claude-cli-profiles', profileId);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));
}

describe('createClaudeAdapter passes the account env to the MCP native-search decision (plan 13d)', () => {
  beforeEach(() => {
    stateRoot.current = realpathSync(mkdtempSync(join(tmpdir(), 'factory-native-search-')));
    const emptyHome = join(stateRoot.current, 'empty-home');
    mkdirSync(emptyHome);
    for (const key of SCRUBBED_ENV) { saved[key] = process.env[key]; delete process.env[key]; }
    process.env['HOME'] = emptyHome;
    process.env['USERPROFILE'] = emptyHome;
  });

  afterEach(() => {
    for (const key of SCRUBBED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(stateRoot.current, { recursive: true, force: true });
  });

  it('lists Harness bridges eagerly when the routed profile settings turn tool search on', () => {
    writeProfileSettings('max-b', { env: { ENABLE_TOOL_SEARCH: 'auto:0' } });

    expect(toolModes(createClaudeAdapter(spawnOptions('max-b')))).toEqual({
      orchestrator: undefined, browser: undefined,
    });
  });

  it('keeps them deferred when the routed profile settings do not turn tool search on', () => {
    writeProfileSettings('max-c', { env: { SOME_OTHER_KEY: 'x' } });

    expect(toolModes(createClaudeAdapter(spawnOptions('max-c')))).toEqual({
      orchestrator: '1', browser: '1',
    });
  });
});
