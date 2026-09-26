/**
 * OpenCode adapter factory (`opencode acp`).
 *
 * OpenCode has no model or effort flag on `opencode acp`; both are applied
 * after the session opens through ACP `session/set_config_option`
 * (`sessionConfig`). Approvals are pinned by an injected permission block in
 * `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the user's global and
 * project config files (probe: docs/plans/2026-09-22-opencode-provider_plan_completed.md,
 * Task 0.1). OpenCode's own credential store holds the backend keys; AIO never
 * reads or passes them.
 */

import { AcpCliAdapter } from './acp-cli-adapter';
import { resolveAcpStallWarningMs } from './acp-prompt-timeout-policy';
import { openCodeProcessGate } from './opencode-process-gate';
import { mapAcpEffort } from './acp-session-config-options';
import { normalizeModelForProvider } from '../../../shared/types/provider.types';
import { getPermissionRegistry } from '../../orchestration/permission-registry';
import { getProviderConcurrencyLimiter } from '../provider-concurrency-limiter';
import { buildBrowserGatewayAcpMcpServers } from '../../browser-gateway/browser-mcp-config';
import { buildChromeDevtoolsAcpMcpServers } from '../../browser-gateway/chrome-devtools-mcp-config';
import { buildMobileMcpAcpMcpServers } from '../../browser-gateway/mobile-mcp-config';
import { getLogger } from '../../logging/logger';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { buildStaticMcpServersAcpMcpServers } from './static-mcp-acp-config';
import {
  buildAcpPermissionContext,
  buildInlineMcpServersAcpMcpServers,
  extendEnvWithRtk,
  mergeAcpMcpServers,
  mergeSpawnEnv,
  withBrowserGatewayProvider,
} from './adapter-spawn-helpers';

const logger = getLogger('OpenCodeAdapterFactory');

export const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

type OpenCodePermissionAction = 'allow' | 'ask';

/**
 * OpenCode's known permission keys (`ConfigPermissionV1`, OpenCode 1.18).
 * Reads stay `allow` with YOLO off; everything that writes, runs, fetches or
 * leaves the workspace asks.
 */
const OPENCODE_READ_PERMISSIONS = ['read', 'list', 'glob', 'grep', 'lsp', 'todowrite', 'skill'] as const;
const OPENCODE_ASK_PERMISSIONS = [
  'edit',
  'bash',
  'task',
  'external_directory',
  'webfetch',
  'websearch',
  'question',
  'doom_loop',
] as const;

/**
 * The permission block AIO injects. `"*"` comes first and carries the same
 * action as the write-side keys: OpenCode evaluates rules last-match-wins in
 * merged key order and keeps the user's key order on merge, so a user's `"*"`
 * that lands after a specific key can only turn a read into `ask`, never a
 * write into `allow`. Every known key is set explicitly because keys AIO does
 * not set survive from the user's own config.
 */
export function buildOpenCodePermissionBlock(yoloMode: boolean): Record<string, OpenCodePermissionAction> {
  const writeAction: OpenCodePermissionAction = yoloMode ? 'allow' : 'ask';
  const block: Record<string, OpenCodePermissionAction> = { '*': writeAction };
  for (const key of OPENCODE_READ_PERMISSIONS) block[key] = 'allow';
  for (const key of OPENCODE_ASK_PERMISSIONS) block[key] = writeAction;
  return block;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge AIO's permission block into an `OPENCODE_CONFIG_CONTENT` that is
 * already in the environment, rather than replacing the caller's config.
 * AIO's permission keys win; an unparseable existing value is replaced.
 */
export function buildOpenCodeConfigContent(existing: string | undefined, yoloMode: boolean): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (isRecord(parsed)) {
        base = parsed;
      } else {
        logger.warn('Ignoring non-object OPENCODE_CONFIG_CONTENT from the environment');
      }
    } catch {
      logger.warn('Ignoring unparseable OPENCODE_CONFIG_CONTENT from the environment');
    }
  }
  const existingPermission = isRecord(base['permission']) ? base['permission'] : {};
  return JSON.stringify({
    ...base,
    permission: { ...existingPermission, ...buildOpenCodePermissionBlock(yoloMode) },
  });
}

/** Explicit `provider/model` id to apply, or undefined to keep OpenCode's default. */
export function resolveOpenCodeSessionModel(model: string | undefined): string | undefined {
  const requested = model?.trim();
  if (!requested || requested.toLowerCase() === 'auto') return undefined;
  return normalizeModelForProvider('opencode', requested)?.trim() || undefined;
}

export function createOpenCodeAdapter(options: UnifiedSpawnOptions): AcpCliAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const browserGatewayMcpServers = options.browserGatewayMcp
    ? buildBrowserGatewayAcpMcpServers(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'opencode'),
      )
    : [];
  const chromeDevtoolsMcpServers = options.chromeDevtoolsMcp
    ? buildChromeDevtoolsAcpMcpServers(options.chromeDevtoolsMcp)
    : [];
  const mobileMcpServers = options.mobileMcp
    ? buildMobileMcpAcpMcpServers(options.mobileMcp)
    : [];
  const inlineMcpServers = buildInlineMcpServersAcpMcpServers(options.mcpConfig);
  // Static, user-managed servers from config/mcp-servers.json (lsp, imap, …) —
  // the same file Claude consumes via --mcp-config and Codex via TOML.
  const staticMcpServers = buildStaticMcpServersAcpMcpServers(options.mcpConfig);
  const yoloMode = options.yoloMode !== false;
  const env = mergeSpawnEnv(options);
  env[OPENCODE_CONFIG_CONTENT_ENV] = buildOpenCodeConfigContent(env[OPENCODE_CONFIG_CONTENT_ENV], yoloMode);
  extendEnvWithRtk(env, options.rtk);
  const model = resolveOpenCodeSessionModel(options.model);
  const effort = mapAcpEffort(options.reasoningEffort);
  return new AcpCliAdapter({
    adapterName: 'opencode-acp',
    command: 'opencode',
    args: ['acp', '--cwd', workingDirectory],
    workingDirectory,
    sessionId: options.sessionId,
    resume: options.resume,
    env,
    mcpServers: mergeAcpMcpServers(
      options.mcpServers,
      inlineMcpServers,
      staticMcpServers,
      browserGatewayMcpServers,
      chromeDevtoolsMcpServers,
      mobileMcpServers,
    ),
    model: options.model,
    ...(model || effort ? { sessionConfig: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } } : {}),
    startupGate: openCodeProcessGate,
    reportedCostOnly: true,
    systemPrompt: options.systemPrompt,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    timeout: options.timeout,
    stallWarningMs: resolveAcpStallWarningMs(Boolean(options.childId)),
    permissionRegistry: getPermissionRegistry(),
    permissionContext: buildAcpPermissionContext(options, 'opencode'),
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'opencode',
    concurrencyAcquireTimeoutMs: 60_000,
    ...(options.concurrencyPriority === 'overflow' ? { concurrencyPriority: 'overflow' as const } : {}),
  });
}
