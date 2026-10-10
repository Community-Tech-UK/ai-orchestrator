/**
 * OpenCode adapter factory (`opencode acp`).
 *
 * OpenCode has no model or effort flag on `opencode acp`; both are applied
 * after the session opens through ACP `session/set_config_option`
 * (`sessionConfig`). Approvals are pinned by an injected permission block in
 * `OPENCODE_CONFIG_CONTENT`, which OpenCode merges over the user's global and
 * project config files (probe: docs/plans/2026-09-22-opencode-provider_plan_completed.md,
 * Task 0.1). OpenCode owns backend credentials; the private configuration
 * probe retains only numeric limits and safe native scope/permission metadata,
 * never native credential values.
 */

import { AcpCliAdapter } from './acp-cli-adapter';
import { resolveAcpStallWarningMs } from './acp-prompt-timeout-policy';
import { openCodeProcessGate } from './opencode-process-gate';
import { createOpenCodeChildProgressSource } from './opencode-child-progress-source';
import { sanitizeOpenCodeContentFilterSource } from './opencode-content-filter-recovery';
import { applyOpenCodeGenerationBudget, assertOpenCodeGenerationBudget } from './opencode-generation-budget';
import { selectOpenCodeLaunch } from './opencode-cli-launch';
import { readOpenCodeEffectiveBudgetConfig } from './opencode-effective-budget-config';
import { mirrorOpenCodeProviderForV2 } from './opencode-v2-config';
import { applyOpenCodePermissionPolicy, assertOpenCodePermissionPolicy } from './opencode-permission-policy';
export { buildOpenCodePermissionBlock } from './opencode-permission-policy';
import {
  applyOpenCodeAccountProviderBlocks,
  buildOpenCodeAccountProviderBlocks,
  resolveOpenCodeSessionModel,
  type OpenCodeAccountProviderDef,
} from './opencode-account-provider-config';
export { resolveOpenCodeSessionModel } from './opencode-account-provider-config';
import { resolveOpenCodeAccountSpawnConfig } from './account-pool/account-adapter-guards';
import {
  ensureOpenCodeRegionModelMetadata,
  getCachedOpenCodeRegionModelMetadata,
} from '../../providers/opencode-region-model-metadata';
import { mapAcpEffort } from './acp-session-config-options';
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
const OPENCODE_MIMO_PROMPT_TIMEOUT_MS = 45 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge AIO's permission block and the per-account MiMo provider definitions
 * into an `OPENCODE_CONFIG_CONTENT` that is already in the environment, rather
 * than replacing the caller's config. AIO's permission keys win; an unparseable
 * existing value is replaced. With no account definitions (a legacy-only or
 * non-MiMo setup) the output is exactly what earlier builds produced.
 */
export function buildOpenCodeConfigContent(
  existing: string | undefined,
  yoloMode: boolean,
  accountProviderBlocks?: Record<string, unknown>,
): string {
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
  applyOpenCodePermissionPolicy(base, yoloMode);
  if (accountProviderBlocks) applyOpenCodeAccountProviderBlocks(base, accountProviderBlocks);
  return JSON.stringify(base);
}

/**
 * MiMo can legitimately spend tens of minutes reasoning over large cached
 * prompts without emitting an ACP update. Recorded local history includes
 * successful turns just under 39 minutes, so use a bounded 45-minute lease;
 * other OpenCode models retain the normal ACP 10-minute timeout.
 */
export function resolveOpenCodePromptTimeoutMs(model: string | undefined): number | undefined {
  return model && /(?:^|\/)mimo(?:-|$)/i.test(model)
    ? OPENCODE_MIMO_PROMPT_TIMEOUT_MS
    : undefined;
}

export function createOpenCodeAdapter(options: UnifiedSpawnOptions): AcpCliAdapter {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const accountSpawn = resolveOpenCodeAccountSpawnConfig(options);
  const accountRegions = [...new Set(accountSpawn.accounts.map((account) => account.region))];
  const accountBlocksFor = (): Record<string, unknown> => {
    const { blocks } = buildOpenCodeAccountProviderBlocks(accountSpawn.accounts, getCachedOpenCodeRegionModelMetadata);
    return blocks;
  };
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
  env[OPENCODE_CONFIG_CONTENT_ENV] = buildOpenCodeConfigContent(
    env[OPENCODE_CONFIG_CONTENT_ENV],
    yoloMode,
    accountBlocksFor(),
  );
  extendEnvWithRtk(env, options.rtk);
  const model = resolveOpenCodeSessionModel(options.model, accountSpawn.routedProviderName);
  const originalConfigContent = env[OPENCODE_CONFIG_CONTENT_ENV]!;
  const budgetConfig = JSON.parse(env[OPENCODE_CONFIG_CONTENT_ENV]!) as Record<string, unknown>;
  const generationBudget = applyOpenCodeGenerationBudget(budgetConfig, model);
  if (generationBudget) env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify(budgetConfig);
  const promptTimeoutMs = resolveOpenCodePromptTimeoutMs(model);
  const effort = mapAcpEffort(options.reasoningEffort);
  const args = ['acp', '--cwd', workingDirectory];
  const childProgress = createOpenCodeChildProgressSource(workingDirectory);
  const adapter = new AcpCliAdapter({
    adapterName: 'opencode-acp',
    command: 'opencode',
    args,
    // Metadata owns its own gated subprocess read. Resolve it before spawn
    // takes that same non-reentrant gate for config probes and ACP initialize.
    beforeStartupGate: async () => {
      if (accountSpawn.accounts.length > 0) await ensureOpenCodeRegionModelMetadata(accountRegions);
    },
    prepareSpawn: async () => {
      const writableRoots = adapter.getHardenedWritableRoots();
      const launch = await selectOpenCodeLaunch({ workingDirectory, env, writableRoots });
      adapter.setSpawnCommand(launch.command);
      const probe = (content: string) => readOpenCodeEffectiveBudgetConfig({ workingDirectory,
        command: launch.command,
        cliMajor: launch.major,
        ...(generationBudget && model ? { model } : {}),
        env: { ...env, [OPENCODE_CONFIG_CONTENT_ENV]: content }, writableRoots,
      });
      const effectiveConfig = await probe(originalConfigContent);
      const currentConfig = JSON.parse(originalConfigContent) as Record<string, unknown>;
      const accountBlocks = accountBlocksFor();
      const routedAccount = accountSpawn.accounts.find(
        (account) => account.providerName === accountSpawn.routedProviderName,
      );
      // Fail closed when the routed account's region metadata is missing or does
      // not offer the model (a cross-region account/model pairing dies inside
      // OpenCode with an opaque model-not-found otherwise).
      if (routedAccount && accountBlocks[routedAccount.providerName] === undefined) {
        throw new Error(
          `The MiMo account "${routedAccount.label}" cannot start: no model metadata for xiaomi-token-plan-${routedAccount.region} `
          + 'on this machine (run `opencode auth login` for that region here once, or use the existing account).',
        );
      }
      if (routedAccount && model && model.startsWith(`${routedAccount.providerName}/`)) {
        const block = accountBlocks[routedAccount.providerName] as { models?: Record<string, unknown> } | undefined;
        const modelId = model.slice(model.indexOf('/') + 1);
        if (block && !(modelId in (block.models ?? {}))) {
          throw new Error(
            `The MiMo account "${routedAccount.label}" cannot run ${modelId}: `
            + `xiaomi-token-plan-${routedAccount.region} does not offer that model on this machine.`,
          );
        }
      }
      applyOpenCodeAccountProviderBlocks(currentConfig, accountBlocks);
      applyOpenCodePermissionPolicy(currentConfig, yoloMode, effectiveConfig);
      if (generationBudget && model) Object.assign(generationBudget, applyOpenCodeGenerationBudget(currentConfig, model, effectiveConfig));
      if (launch.major >= 2) mirrorOpenCodeProviderForV2(currentConfig);
      const preparedContent = JSON.stringify(currentConfig);
      const verified = await probe(preparedContent);
      assertOpenCodePermissionPolicy(verified);
      if (generationBudget) assertOpenCodeGenerationBudget(verified, generationBudget);
      env[OPENCODE_CONFIG_CONTENT_ENV] = preparedContent;
      return childProgress.prepareSpawn(args, env, { serveHttp: launch.major < 2 });
    },
    childProgressSource: childProgress.source,
    prepareContentFilterRecovery: (sessionId, toolCallId, signal) => sanitizeOpenCodeContentFilterSource(childProgress.request, sessionId, signal, toolCallId),
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
    ...(accountSpawn.route ? { requireSessionModelConfirmation: true } : {}),
    startupGate: openCodeProcessGate,
    reportedCostOnly: true,
    generationBudget,
    systemPrompt: options.systemPrompt,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    timeout: options.timeout,
    ...(promptTimeoutMs ? { promptTimeoutMs } : {}),
    stallWarningMs: resolveAcpStallWarningMs(Boolean(options.childId)),
    permissionRegistry: getPermissionRegistry(),
    permissionContext: buildAcpPermissionContext(options, 'opencode'),
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'opencode',
    concurrencyAcquireTimeoutMs: 60_000,
    ...(options.concurrencyPriority === 'overflow' ? { concurrencyPriority: 'overflow' as const } : {}),
  });
  return adapter;
}
