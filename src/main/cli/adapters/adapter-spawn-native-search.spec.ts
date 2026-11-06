import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeMcpConfig } from './adapter-spawn-helpers';
import { buildOrchestratorToolsMcpConfig, resolveOrchestratorToolMode } from '../../mcp/orchestrator-tools-mcp-config';
import { buildBrowserGatewayMcpConfigJson, resolveBrowserGatewayToolMode } from '../../browser-gateway/browser-mcp-config';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV } from '../../mcp/orchestrator-mcp-deferral';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const bridge = {
  aioMcpCliPath: '/fixture/aio-mcp', socketPath: '/fixture/socket', instanceId: 'fixture',
  provider: 'claude', toolDeferral: true, exists: () => true,
};
function modes(configs: string[] | undefined) {
  return Object.assign({}, ...(configs ?? []).map(entry => JSON.parse(entry).mcpServers)) as Record<string, { env: Record<string, string> }>;
}

describe('Claude native search on final MCP spawn configuration', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-search-config-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each([['claude', 'eager'], ['codex', 'stable'], ['cursor', 'eager']] as const)(
    'preserves %s provider mode with native search on', (provider, mode) => {
      expect(resolveOrchestratorToolMode(provider, true, { nativeToolSearch: 'on' })).toBe(mode);
      expect(resolveBrowserGatewayToolMode(provider, true, { nativeToolSearch: 'on' })).toBe(mode);
      const servers = modes([
        buildOrchestratorToolsMcpConfig({ ...bridge, provider, nativeToolSearch: 'on' })!,
        buildBrowserGatewayMcpConfigJson({ ...bridge, provider, nativeToolSearch: 'on' })!,
      ]);
      expect(servers['orchestrator'].env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBeUndefined();
      expect(servers['browser-gateway'].env['AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL']).toBeUndefined();
    },
  );

  it.each([
    ['auto:0', 'claude-opus-4-8', 'https://api.anthropic.com', true],
    ['true', 'claude-opus-4-8', 'https://proxy.example.invalid', true],
    ['false', 'claude-opus-4-8', 'https://api.anthropic.com', false],
    ['auto:10', 'claude-opus-4-8', 'https://api.anthropic.com', false],
    ['auto:0', 'claude-haiku-4-6', 'https://api.anthropic.com', false],
    ['auto:0', 'claude-opus-4-8', 'https://proxy.example.invalid', false],
    ['auto:0', 'claude-opus-4-8', 'https://anthropic.proxy.example.invalid', false],
    ['auto:0', 'claude-opus-4-8', 'invalid-anthropic-url', false],
  ] as const)('flag %s / model %s / host %s uses native search=%s', (flag, model, baseUrl, eager) => {
    const configs = buildClaudeMcpConfig({
      model, env: { ENABLE_TOOL_SEARCH: flag, ANTHROPIC_BASE_URL: baseUrl, CLAUDE_CONFIG_DIR: root },
      mcpConfig: [buildOrchestratorToolsMcpConfig(bridge)!, buildBrowserGatewayMcpConfigJson(bridge)!],
    });
    const servers = modes(configs);
    expect(servers['orchestrator'].env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBe(eager ? undefined : '1');
    expect(servers['browser-gateway'].env['AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL']).toBe(eager ? undefined : '1');
    expect(servers['orchestrator'].env['AI_ORCHESTRATOR_INSTANCE_ID']).toBe('fixture');
  });

  it('applies account-profile settings and preserves explicit spawn-env precedence', () => {
    const profile = join(root, 'profile'); mkdirSync(profile);
    writeFileSync(join(profile, 'settings.json'), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: 'auto:0' } }));
    const options = {
      model: 'claude-opus-4-8', env: { CLAUDE_CONFIG_DIR: root }, browserGatewayMcp: bridge,
      mcpConfig: [buildOrchestratorToolsMcpConfig(bridge)!],
    };
    // Simulates the account resolver's final environment, after route selection.
    const accountEnv = { env: { CLAUDE_CONFIG_DIR: profile }, envRemove: [] };
    const configured = modes(buildClaudeMcpConfig(options, accountEnv));
    expect(configured['browser-gateway'].env['AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL']).toBeUndefined();
    expect(configured['orchestrator'].env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBeUndefined();
    const explicit = modes(buildClaudeMcpConfig({ ...options, env: { ...options.env, ENABLE_TOOL_SEARCH: 'false' } }, accountEnv));
    expect(explicit['orchestrator'].env[ORCHESTRATOR_TOOL_DEFERRAL_ENV]).toBe('1');
  });
});
