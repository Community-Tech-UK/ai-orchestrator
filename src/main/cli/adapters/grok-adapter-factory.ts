/**
 * Grok Build adapter factory. Split out of adapter-factory.ts (which
 * re-exports it) to keep that file under its size ceiling.
 */

import { AcpCliAdapter } from './acp-cli-adapter';
import { resolveAcpStallWarningMs } from './acp-prompt-timeout-policy';
import { normalizeModelForProvider } from '../../../shared/types/provider.types';
import { getPermissionRegistry } from '../../orchestration/permission-registry';
import { getProviderConcurrencyLimiter } from '../provider-concurrency-limiter';
import { buildBrowserGatewayAcpMcpServers } from '../../browser-gateway/browser-mcp-config';
import { buildChromeDevtoolsAcpMcpServers } from '../../browser-gateway/chrome-devtools-mcp-config';
import { buildMobileMcpAcpMcpServers } from '../../browser-gateway/mobile-mcp-config';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import {
  buildAcpPermissionContext,
  buildInlineMcpServersAcpMcpServers,
  extendEnvWithRtk,
  mergeSpawnEnv,
  withBrowserGatewayProvider,
} from './adapter-spawn-helpers';

/**
 * Creates a Grok Build CLI adapter via ACP (`grok agent stdio`).
 *
 * Model and reasoning effort are global flags on `grok agent` (before the
 * `stdio` subcommand). `--always-approve` matches yolo / unattended runs so
 * `session/request_permission` does not block the turn.
 */
export function createGrokAdapter(options: UnifiedSpawnOptions): AcpCliAdapter {
  const browserGatewayMcpServers = options.browserGatewayMcp
    ? buildBrowserGatewayAcpMcpServers(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'grok'),
      )
    : [];
  const chromeDevtoolsMcpServers = options.chromeDevtoolsMcp
    ? buildChromeDevtoolsAcpMcpServers(options.chromeDevtoolsMcp)
    : [];
  const mobileMcpServers = options.mobileMcp
    ? buildMobileMcpAcpMcpServers(options.mobileMcp)
    : [];
  const inlineMcpServers = buildInlineMcpServersAcpMcpServers(options.mcpConfig);
  const agentArgs: string[] = ['agent'];
  // Normalized at the spawn boundary, not only at session-create: wake/restart/
  // resume rebuild spawn options from the persisted `instance.currentModel`, and
  // an id xAI has retired fails the spawn outright ("unknown model id", exit 1).
  // Only an EXPLICIT model is normalized — absent one, `-m` stays off so the CLI
  // picks its own default rather than us pinning the last id we hard-coded.
  const requestedModel = options.model?.trim()
    ? normalizeModelForProvider('grok', options.model)?.trim()
    : undefined;
  if (requestedModel && requestedModel.toLowerCase() !== 'auto') {
    agentArgs.push('-m', requestedModel);
  }
  const effort = options.reasoningEffort?.trim();
  if (effort && effort !== 'none' && effort !== 'workflow') {
    const mapped =
      effort === 'minimal' ? 'low'
        : effort === 'xhigh' || effort === 'max' ? 'high'
          : effort;
    if (mapped === 'low' || mapped === 'medium' || mapped === 'high') {
      agentArgs.push('--reasoning-effort', mapped);
    }
  }
  if (options.yoloMode !== false) {
    agentArgs.push('--always-approve');
  }
  agentArgs.push('stdio');
  const env = mergeSpawnEnv(options);
  extendEnvWithRtk(env, options.rtk);
  return new AcpCliAdapter({
    adapterName: 'grok-acp',
    command: 'grok',
    args: agentArgs,
    workingDirectory: options.workingDirectory ?? process.cwd(),
    sessionId: options.sessionId,
    resume: options.resume,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    mcpServers: [
      ...(options.mcpServers ?? []),
      ...inlineMcpServers,
      ...browserGatewayMcpServers,
      ...chromeDevtoolsMcpServers,
      ...mobileMcpServers,
    ],
    model: options.model,
    systemPrompt: options.systemPrompt,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    timeout: options.timeout,
    stallWarningMs: resolveAcpStallWarningMs(Boolean(options.childId)),
    permissionRegistry: getPermissionRegistry(),
    permissionContext: buildAcpPermissionContext(options, 'grok'),
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'grok',
    concurrencyAcquireTimeoutMs: 60_000,
    ...(options.concurrencyPriority === 'overflow' ? { concurrencyPriority: 'overflow' as const } : {}),
  });
}
