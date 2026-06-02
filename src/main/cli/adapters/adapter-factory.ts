/**
 * CLI Adapter Factory - Creates appropriate CLI adapters based on provider type
 *
 * Centralizes adapter instantiation to support multiple CLI providers:
 * - Claude Code CLI
 * - OpenAI Codex CLI
 * - Google Gemini CLI
 * - Ollama (future)
 *
 * Spawn-option types live in adapter-factory.types.ts; env/MCP-config spawn
 * helpers live in adapter-spawn-helpers.ts. Both are re-exported here so
 * existing import sites keep working.
 */

import { ClaudeCliAdapter, ClaudeCliSpawnOptions } from './claude-cli-adapter';
import { CodexCliAdapter, CodexCliConfig } from './codex-cli-adapter';
import { GeminiCliAdapter, GeminiCliConfig } from './gemini-cli-adapter';
import { OllamaCliAdapter } from './ollama-cli-adapter';
import { AcpCliAdapter } from './acp-cli-adapter';
import { RemoteCliAdapter } from './remote-cli-adapter';
import { CliDetectionService, CliType } from '../cli-detection';
import { getDefaultCopilotCliLaunch } from '../copilot-cli-launch';
import type { CliType as SettingsCliType } from '../../../shared/types/settings.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { getWorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { getLogger } from '../../logging/logger';
import { getPermissionRegistry } from '../../orchestration/permission-registry';
import { getProviderConcurrencyLimiter } from '../provider-concurrency-limiter';
import {
  buildBrowserGatewayAcpMcpServers,
  buildBrowserGatewayCodexConfigToml,
} from '../../browser-gateway/browser-mcp-config';
import {
  buildChromeDevtoolsAcpMcpServers,
  buildChromeDevtoolsCodexConfigToml,
} from '../../browser-gateway/chrome-devtools-mcp-config';
import type { UnifiedSpawnOptions, CliAdapter } from './adapter-factory.types';
import { buildStaticMcpServersCodexConfigToml } from './static-mcp-codex-config';
import {
  acpEphemeralInstanceId,
  buildClaudeMcpConfig,
  buildCopilotAdditionalMcpConfig,
  buildCopilotSpawnEnv,
  extendEnvWithRtk,
  getCopilotOrchestratorHome,
  mergeSpawnEnv,
  toCodexReasoningEffort,
  withBrowserGatewayProvider,
  withBrowserGatewaySystemPrompt,
  writeGeminiBrowserGatewaySettings,
} from './adapter-spawn-helpers';

const logger = getLogger('AdapterFactory');

// Re-export the spawn-option types so existing `import { UnifiedSpawnOptions,
// CliAdapter } from './adapter-factory'` sites keep resolving.
export type { UnifiedSpawnOptions, CliAdapter } from './adapter-factory.types';

/**
 * Maps settings CliType to detection CliType
 */
export function mapSettingsToDetectionType(settingsType: SettingsCliType): CliType | 'auto' {
  switch (settingsType) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'openai':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'copilot':
      return 'copilot';
    case 'cursor':
      return 'cursor';
    case 'auto':
      return 'auto';
    default:
      return 'auto';
  }
}

/**
 * Resolves the CLI type to use based on settings and availability
 */
export async function resolveCliType(
  requestedType?: SettingsCliType | CliType,
  defaultType: SettingsCliType = 'auto'
): Promise<CliType> {
  const detection = CliDetectionService.getInstance();
  logger.debug('resolveCliType called', { requestedType, defaultType });

  // If explicitly requested (not 'auto'), try to use it
  if (requestedType && requestedType !== 'auto') {
    const cliType = mapSettingsToDetectionType(requestedType as SettingsCliType);
    logger.debug('Mapped requested type to CLI type', { requestedType, cliType });
    if (cliType !== 'auto') {
      // Verify it's available
      const result = await detection.detectAll();
      const availableClis = result.available.map(c => c.name);
      logger.debug('Available CLIs', { clis: availableClis });
      const isAvailable = result.available.some((cli) => cli.name === cliType);
      logger.debug('Checking availability', { cliType, isAvailable });
      if (isAvailable) {
        return cliType;
      }
      logger.warn('Requested CLI not available, falling back to auto', { requestedType, cliType });
    }
  }

  // Auto-detect: use default setting or find first available
  if (defaultType !== 'auto') {
    const cliType = mapSettingsToDetectionType(defaultType);
    if (cliType !== 'auto') {
      const result = await detection.detectAll();
      const isAvailable = result.available.some((cli) => cli.name === cliType);
      if (isAvailable) {
        return cliType;
      }
    }
  }

  // Fall back to first available CLI (priority: claude > codex > gemini > ollama)
  const result = await detection.detectAll();
  const priority: CliType[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'ollama'];
  logger.debug('Falling back to auto-detect', { priority });

  for (const cli of priority) {
    if (result.available.some((c) => c.name === cli)) {
      logger.info('Auto-selected CLI', { cli });
      return cli;
    }
  }

  // Default to Claude if nothing is detected (will fail gracefully later)
  logger.warn('No CLI detected, defaulting to claude');
  return 'claude';
}

/**
 * Creates a Claude CLI adapter
 */
export function createClaudeAdapter(options: UnifiedSpawnOptions): ClaudeCliAdapter {
  const claudeOptions: ClaudeCliSpawnOptions = {
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    systemPrompt: options.systemPrompt,
    model: options.model,
    timeout: options.timeout,
    yoloMode: options.yoloMode,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    resume: options.resume,
    forkSession: options.forkSession,
    mcpConfig: buildClaudeMcpConfig(options),
    reasoningEffort: options.reasoningEffort,
    bare: options.bare,
    name: options.name,
    // Default prompt-section exclusion to true for orchestrated instances —
    // they share similar prompts and benefit from cross-instance cache hits.
    excludeDynamicSystemPromptSections: options.excludeDynamicSystemPromptSections ?? true,
    chrome: options.chrome,
    permissionHookPath: options.permissionHookPath,
    env: options.env,
    rtk: options.rtk,
  };
  return new ClaudeCliAdapter(claudeOptions);
}

/**
 * Creates a Codex CLI adapter
 */
export function createCodexAdapter(options: UnifiedSpawnOptions): CodexCliAdapter {
  const codexTomlBlocks = [
    options.browserGatewayMcp
      ? buildBrowserGatewayCodexConfigToml(
          withBrowserGatewayProvider(options.browserGatewayMcp, 'codex'),
        )
      : null,
    options.chromeDevtoolsMcp
      ? buildChromeDevtoolsCodexConfigToml(options.chromeDevtoolsMcp)
      : null,
    // Static, user-managed servers from config/mcp-servers.json (lsp, imap, …).
    // Claude/Copilot get these via --mcp-config; Codex needs them as TOML.
    buildStaticMcpServersCodexConfigToml(options.mcpConfig),
  ].filter((block): block is string => Boolean(block));
  const mcpServersConfigToml = codexTomlBlocks.length > 0
    ? codexTomlBlocks.join('\n\n')
    : null;
  const codexEnv = mergeSpawnEnv(options);
  extendEnvWithRtk(codexEnv, options.rtk);
  const codexConfig: CodexCliConfig = {
    // AI Orchestrator owns its own session/history surface. Codex threads
    // created here should not leak into the standalone Codex desktop app
    // unless a caller explicitly opts out.
    ephemeral: options.ephemeral ?? true,
    sessionId: options.sessionId,
    resume: options.resume,
    workingDir: options.workingDirectory,
    model: options.model,
    systemPrompt: options.systemPrompt,
    approvalMode: options.yoloMode ? 'full-auto' : 'suggest',
    sandboxMode: options.yoloMode ? 'danger-full-access' : 'read-only',
    timeout: options.timeout,
    outputSchema: options.outputSchema,
    reasoningEffort: toCodexReasoningEffort(options.reasoningEffort),
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    ...(Object.keys(codexEnv).length > 0 ? { env: codexEnv } : {}),
    ...(mcpServersConfigToml ? { mcpServersConfigToml } : {}),
  };
  return new CodexCliAdapter(codexConfig);
}

/**
 * Creates a Gemini CLI adapter
 */
export function createGeminiAdapter(options: UnifiedSpawnOptions): GeminiCliAdapter {
  const browserGatewaySettingsPath = writeGeminiBrowserGatewaySettings(options);
  const env = mergeSpawnEnv(options);
  if (browserGatewaySettingsPath) {
    env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'] = browserGatewaySettingsPath;
  }
  extendEnvWithRtk(env, options.rtk);
  const geminiConfig: GeminiCliConfig = {
    workingDir: options.workingDirectory,
    model: options.model,
    // Default yolo on: Gemini runs one-shot non-interactively here, so without
    // --yolo it strips tools needing approval (run_shell_command, write_file, etc.)
    // from the registry. The orchestrator is the approval layer for child instances.
    yoloMode: options.yoloMode ?? true,
    timeout: options.timeout,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(browserGatewaySettingsPath ? { browserGatewaySettingsPath } : {}),
  };
  return new GeminiCliAdapter(geminiConfig);
}

/**
 * Creates a Copilot CLI adapter.
 * Uses the standalone `copilot` binary when available, otherwise falls back
 * to the GitHub CLI wrapper (`gh copilot`) which can bootstrap Copilot itself.
 *
 * NOTE: The ACP adapter layer holds `options.model` in its config but does not
 * forward it to the subprocess. Copilot honors `--model` even in `--acp` mode,
 * so we must inject the flag here at spawn time. Without this, the selected
 * model silently falls back to the copilot binary's configured default
 * (typically "auto"), so the orchestrator UI shows the chosen model but the
 * Copilot session actually runs a different one.
 */
export function createCopilotAdapter(options: UnifiedSpawnOptions): AcpCliAdapter {
  const launch = getDefaultCopilotCliLaunch();
  const modelArgs: string[] = [];
  const requestedModel = options.model?.trim();
  if (requestedModel) {
    const normalizedModel =
      requestedModel.toLowerCase() === 'auto' ? 'auto' : requestedModel;
    modelArgs.push('--model', normalizedModel);
  }
  const isolateProviderState = options.ephemeral ?? true;
  const copilotHomeDir = isolateProviderState ? getCopilotOrchestratorHome() : undefined;
  const providerStateArgs = copilotHomeDir
    ? ['--config-dir', copilotHomeDir, '--no-remote']
    : [];
  const env = mergeSpawnEnv(options, buildCopilotSpawnEnv());
  if (copilotHomeDir) {
    // AI Orchestrator owns its own session/history surface. Copilot ACP
    // sessions created here should not write into ~/.copilot, because VS
    // Code's Copilot Chat session list indexes that state directory.
    env['COPILOT_HOME'] = copilotHomeDir;
  }
  extendEnvWithRtk(env, options.rtk);
  const browserGatewayMcpServers = options.browserGatewayMcp
    ? buildBrowserGatewayAcpMcpServers(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'copilot'),
      )
    : [];
  const chromeDevtoolsMcpServers = options.chromeDevtoolsMcp
    ? buildChromeDevtoolsAcpMcpServers(options.chromeDevtoolsMcp)
    : [];
  const copilotMcpServers = [
    ...(options.mcpServers ?? []),
    ...browserGatewayMcpServers,
    ...chromeDevtoolsMcpServers,
  ];
  const additionalMcpConfig = buildCopilotAdditionalMcpConfig(copilotMcpServers);
  return new AcpCliAdapter({
    adapterName: 'copilot-acp',
    command: launch.command,
    args: [
      ...launch.argsPrefix,
      '--acp',
      '--stdio',
      '--no-auto-update',
      '--log-level',
      'none',
      '--allow-all-tools',
      '--allow-all-paths',
      '--allow-all-urls',
      '--no-ask-user',
      ...providerStateArgs,
      ...modelArgs,
      ...(additionalMcpConfig ? ['--additional-mcp-config', additionalMcpConfig] : []),
    ],
    workingDirectory: options.workingDirectory ?? process.cwd(),
    sessionId: options.sessionId,
    resume: options.resume,
    env,
    mcpServers: [],
    model: options.model,
    systemPrompt: options.systemPrompt,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    timeout: options.timeout,
    requestTimeoutMs: 20_000,
    concurrencyAcquireTimeoutMs: 30_000,
    stallWarningMs: options.childId ? 90_000 : undefined,
    // Wire the permission registry so Copilot's `session/request_permission`
    // RPCs can be auto-timed-out and surfaced to the UI. Without this,
    // a permission prompt from Copilot would block the `session/prompt`
    // promise forever (observed as a "Making edits / Processing…" stuck UI).
    permissionRegistry: getPermissionRegistry(),
    permissionContext: {
      instanceId: options.instanceId ?? acpEphemeralInstanceId('copilot'),
      childId: options.childId,
    },
    // Gate concurrent Copilot spawns behind the shared semaphore. Prevents
    // the 5+ parallel-children fan-out pattern that amplified the hang.
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'copilot',
  });
}

/**
 * Creates a Cursor CLI adapter (spawns the `cursor-agent` binary directly).
 */
export function createCursorAdapter(options: UnifiedSpawnOptions): AcpCliAdapter {
  const browserGatewayMcpServers = options.browserGatewayMcp
    ? buildBrowserGatewayAcpMcpServers(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'cursor'),
      )
    : [];
  const chromeDevtoolsMcpServers = options.chromeDevtoolsMcp
    ? buildChromeDevtoolsAcpMcpServers(options.chromeDevtoolsMcp)
    : [];
  const env = mergeSpawnEnv(options);
  extendEnvWithRtk(env, options.rtk);
  return new AcpCliAdapter({
    adapterName: 'cursor-acp',
    command: 'cursor-agent',
    args: ['acp'],
    workingDirectory: options.workingDirectory ?? process.cwd(),
    sessionId: options.sessionId,
    resume: options.resume,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    mcpServers: [
      ...(options.mcpServers ?? []),
      ...browserGatewayMcpServers,
      ...chromeDevtoolsMcpServers,
    ],
    model: options.model,
    systemPrompt: options.systemPrompt,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    timeout: options.timeout,
    // Same rationale as createCopilotAdapter: keep the ACP permission
    // auto-timeout active so `session/request_permission` hangs surface
    // in the UI instead of silently blocking the prompt turn.
    permissionRegistry: getPermissionRegistry(),
    permissionContext: {
      instanceId: options.instanceId ?? acpEphemeralInstanceId('cursor'),
      childId: options.childId,
    },
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'cursor',
  });
}

/**
 * Creates an Ollama adapter that communicates with the local Ollama REST API.
 * Requires a running Ollama daemon (ollama serve or Ollama.app).
 */
export function createOllamaAdapter(options: UnifiedSpawnOptions): OllamaCliAdapter {
  return new OllamaCliAdapter({
    model: options.model,
    systemPrompt: options.systemPrompt,
    workingDir: options.workingDirectory,
    timeout: options.timeout,
  });
}

/**
 * Creates a CLI adapter for the specified type
 * Returns a ClaudeCliAdapter for Claude, or the appropriate adapter for other types
 */
export function createCliAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  executionLocation?: ExecutionLocation,
): CliAdapter {
  const effectiveOptions = withBrowserGatewaySystemPrompt(options);
  // If remote, create a RemoteCliAdapter regardless of CLI type
  if (executionLocation?.type === 'remote') {
    const connection = getWorkerNodeConnectionServer();
    return new RemoteCliAdapter(connection, executionLocation.nodeId, cliType, effectiveOptions);
  }

  switch (cliType) {
    case 'claude':
      return createClaudeAdapter(effectiveOptions);

    case 'codex':
      return createCodexAdapter(effectiveOptions);

    case 'gemini':
      return createGeminiAdapter(effectiveOptions);

    case 'copilot':
      return createCopilotAdapter(effectiveOptions);

    case 'cursor':
      return createCursorAdapter(effectiveOptions);

    case 'ollama':
      return createOllamaAdapter(effectiveOptions);

    default:
      throw new Error(`Unknown CLI type: ${cliType}`);
  }
}

/**
 * Creates a CLI adapter with automatic type resolution
 */
export async function createCliAdapterAuto(
  options: UnifiedSpawnOptions,
  requestedType?: SettingsCliType | CliType,
  defaultType: SettingsCliType = 'auto'
): Promise<{ adapter: CliAdapter; cliType: CliType }> {
  const cliType = await resolveCliType(requestedType, defaultType);
  const adapter = createCliAdapter(cliType, options);
  return { adapter, cliType };
}

/**
 * Get display name for a CLI type
 */
export function getCliDisplayName(cliType: CliType): string {
  switch (cliType) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'OpenAI Codex';
    case 'gemini':
      return 'Google Gemini';
    case 'copilot':
      return 'GitHub Copilot';
    case 'cursor':
      return 'Cursor CLI';
    case 'ollama':
      return 'Ollama';
    default:
      return cliType;
  }
}
