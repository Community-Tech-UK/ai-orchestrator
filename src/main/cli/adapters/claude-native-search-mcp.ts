import type { UnifiedSpawnOptions } from './adapter-factory.types';
import type { ClaudeAccountSpawnEnv } from './account-pool/account-adapter-guards';
import { detectClaudeNativeToolSearch } from './claude-native-tool-search';
import { resolveBrowserGatewayToolMode } from '../../browser-gateway/browser-mcp-config';
import { BROWSER_TOOL_DEFERRAL_ENV } from '../../browser-gateway/browser-mcp-deferral';
import { resolveOrchestratorToolMode } from '../../mcp/orchestrator-tools-mcp-config';
import { ORCHESTRATOR_TOOL_DEFERRAL_ENV } from '../../mcp/orchestrator-mcp-deferral';
import { getLogger } from '../../logging/logger';

/**
 * Final Claude config seam, after account routing. SpawnConfigBuilder has no
 * model or resolved account home; deciding there would use the wrong settings
 * for profile-routed sessions. Reconcile only Harness-generated inline bridges,
 * leaving user config files and unrelated MCP servers intact.
 */
export function configureClaudeNativeSearchMcp(
  configs: string[],
  options: Pick<UnifiedSpawnOptions, 'model' | 'env'>,
  account: ClaudeAccountSpawnEnv = { env: {}, envRemove: [] },
): string[] {
  const env = { ...options.env, ...account.env };
  const processEnv = { ...process.env };
  for (const key of account.envRemove) { delete env[key]; delete processEnv[key]; }
  const nativeToolSearch = detectClaudeNativeToolSearch(options.model, env, processEnv);
  return configs.map(entry => {
    if (!entry.trim().startsWith('{')) return entry;
    try {
      const parsed = JSON.parse(entry) as { mcpServers?: Record<string, unknown> };
      if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return entry;
      let changed = false;
      for (const server of Object.values(parsed.mcpServers)) {
        if (!server || typeof server !== 'object' || Array.isArray(server)) continue;
        const bridge = server as { args?: unknown; env?: Record<string, unknown> };
        if (!Array.isArray(bridge.args) || !bridge.env || typeof bridge.env !== 'object') continue;
        const orchestrator = bridge.args.length === 1 && bridge.args[0] === 'orchestrator-tools'
          && typeof bridge.env['AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET'] === 'string';
        const browser = bridge.args.length === 1 && bridge.args[0] === 'browser-gateway'
          && typeof bridge.env['AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET'] === 'string';
        if (!orchestrator && !browser) continue;
        const key = orchestrator ? ORCHESTRATOR_TOOL_DEFERRAL_ENV : BROWSER_TOOL_DEFERRAL_ENV;
        const resolver = orchestrator ? resolveOrchestratorToolMode : resolveBrowserGatewayToolMode;
        const mode = resolver('claude', bridge.env[key] === '1', { nativeToolSearch });
        if (mode === 'eager' && key in bridge.env) {
          delete bridge.env[key];
          changed = true;
        }
        getLogger('ClaudeNativeSearchMcp').info('Claude MCP tool search resolved', {
          nativeToolSearch, toolMode: mode, surface: orchestrator ? 'orchestrator' : 'browser',
        });
      }
      return changed ? JSON.stringify(parsed) : entry;
    } catch { return entry; }
  });
}
