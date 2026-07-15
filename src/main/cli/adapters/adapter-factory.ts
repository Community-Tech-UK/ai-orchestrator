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
import { AntigravityCliAdapter, AntigravityCliConfig } from './antigravity-cli-adapter';
import { OllamaCliAdapter } from './ollama-cli-adapter';
import {
  OpenAICompatibleChatAdapter,
  type OpenAICompatibleChatConfig,
} from './openai-compatible-chat-adapter';
import { AcpCliAdapter } from './acp-cli-adapter';
import { RemoteCliAdapter } from './remote-cli-adapter';
import { RemoteLocalModelAdapter } from './remote-local-model-adapter';
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
import {
  buildMobileMcpAcpMcpServers,
  buildMobileMcpCodexConfigToml,
} from '../../browser-gateway/mobile-mcp-config';
import type { UnifiedSpawnOptions, CliAdapter } from './adapter-factory.types';
import {
  buildInlineMcpServersCodexConfigToml,
  buildStaticMcpServersCodexConfigToml,
} from './static-mcp-codex-config';
import {
  acpEphemeralInstanceId,
  buildClaudeMcpConfig,
  buildCopilotAdditionalMcpConfig,
  buildCopilotSpawnEnv,
  buildInlineMcpServersAcpMcpServers,
  extendEnvWithRtk,
  getCopilotOrchestratorHome,
  mergeSpawnEnv,
  toCodexReasoningEffort,
  withBrowserGatewayProvider,
  withBrowserGatewaySystemPrompt,
  writeGeminiBrowserGatewaySettings,
} from './adapter-spawn-helpers';

const logger = getLogger('AdapterFactory');
const INTERACTIVE_RUNTIME_UNAVAILABLE =
  'Interactive Claude launch mode requires the terminal runtime, which is not available in this build. Switch to Orchestrated to start a managed Harness session.';

// Re-export the spawn-option types so existing `import { UnifiedSpawnOptions,
// CliAdapter } from './adapter-factory'` sites keep resolving.
export type { UnifiedSpawnOptions, CliAdapter } from './adapter-factory.types';

/**
 * Maps settings CliType to detection CliType
 */
export function mapSettingsToDetectionType(settingsType: SettingsCliType | CliType): CliType | 'auto' {
  switch (settingsType) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'openai':
      return 'codex';
    case 'gemini':
      // Legacy alias: the Gemini CLI has been replaced by Antigravity (`agy`).
      // Persisted `gemini` selections resolve to the antigravity runtime.
      return 'antigravity';
    case 'antigravity':
      return 'antigravity';
    case 'copilot':
      return 'copilot';
    case 'cursor':
      return 'cursor';
    case 'grok':
      return 'grok';
    case 'ollama':
      return 'ollama';
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
  const result = await detection.detectAll();
  const isAvailable = (cliType: CliType): boolean =>
    result.available.some((cli) => cli.name === cliType);

  // If explicitly requested (not 'auto'), try to use it
  if (requestedType && requestedType !== 'auto') {
    const cliType = mapSettingsToDetectionType(requestedType);
    logger.debug('Mapped requested type to CLI type', { requestedType, cliType });
    if (cliType !== 'auto') {
      // Verify it's available
      const availableClis = result.available.map(c => c.name);
      logger.debug('Available CLIs', { clis: availableClis });
      const cliIsAvailable = isAvailable(cliType);
      logger.debug('Checking availability', { cliType, isAvailable: cliIsAvailable });
      if (cliIsAvailable) {
        return cliType;
      }
      logger.warn('Requested CLI not available, falling back to auto', { requestedType, cliType });
    }
  }

  // Auto-detect: use default setting or find first available
  if (defaultType !== 'auto') {
    const cliType = mapSettingsToDetectionType(defaultType);
    if (cliType !== 'auto') {
      if (isAvailable(cliType)) {
        return cliType;
      }
    }
  }

  // Fall back to first available CLI.
  const priority: CliType[] = ['claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok', 'ollama'];
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
  if (options.launchMode === 'interactive') {
    throw new Error(INTERACTIVE_RUNTIME_UNAVAILABLE);
  }

  const claudeOptions: ClaudeCliSpawnOptions = {
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    systemPrompt: options.systemPrompt,
    model: options.model,
    timeout: options.timeout,
    maxTurns: options.maxTurns,
    yoloMode: options.yoloMode,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    resume: options.resume,
    forkSession: options.forkSession,
    mcpConfig: buildClaudeMcpConfig(options),
    reasoningEffort: options.reasoningEffort,
    fastMode: options.fastMode,
    residentClaude: options.residentClaude,
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
    options.mobileMcp
      ? buildMobileMcpCodexConfigToml(options.mobileMcp)
      : null,
    buildInlineMcpServersCodexConfigToml(options.mcpConfig),
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
    // Harness owns its own session/history surface. Codex threads
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
    fastMode: options.fastMode,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    ...(options.browserGatewayMcp?.instanceId ? { browserGatewayInstanceId: options.browserGatewayMcp.instanceId } : {}),
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
 * Creates an Antigravity CLI adapter (spawns the `agy` binary).
 *
 * Successor to createGeminiAdapter. agy has no `--output-format` flag and no
 * Gemini-style browser-gateway settings path, so this is a simpler env merge.
 */
export function createAntigravityAdapter(options: UnifiedSpawnOptions): AntigravityCliAdapter {
  const env = mergeSpawnEnv(options);
  extendEnvWithRtk(env, options.rtk);
  const antigravityConfig: AntigravityCliConfig = {
    workingDir: options.workingDirectory,
    model: options.model,
    // Default auto-approve on: agy runs one-shot non-interactively here, so
    // without --dangerously-skip-permissions it would block on tool-permission
    // prompts. The orchestrator is the approval layer for managed instances.
    yoloMode: options.yoloMode ?? true,
    systemPrompt: options.systemPrompt,
    timeout: options.timeout,
    rtkEnabled: Boolean(options.rtk?.enabled && options.rtk.binaryPath),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return new AntigravityCliAdapter(antigravityConfig);
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
    // Harness owns its own session/history surface. Copilot ACP
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
  const mobileMcpServers = options.mobileMcp
    ? buildMobileMcpAcpMcpServers(options.mobileMcp)
    : [];
  const inlineMcpServers = buildInlineMcpServersAcpMcpServers(options.mcpConfig);
  const copilotMcpServers = [
    ...(options.mcpServers ?? []),
    ...inlineMcpServers,
    ...browserGatewayMcpServers,
    ...chromeDevtoolsMcpServers,
    ...mobileMcpServers,
  ];
  const additionalMcpConfig = buildCopilotAdditionalMcpConfig(copilotMcpServers);
  return new AcpCliAdapter({
    adapterName: 'copilot-acp',
    contextCapabilityProfile: 'copilot-acp',
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
 *
 * NOTE: Same trap as createCopilotAdapter — the ACP layer holds `options.model`
 * but never forwards it to the subprocess, and `session/new` carries no model
 * field. `cursor-agent acp` accepts the global `--model` flag, so we inject it at
 * spawn time. Without it the session silently runs cursor-agent's configured
 * default while the orchestrator UI shows the chosen model (observed: UI shows
 * "Composer 2.5" but the agent self-reports a different model). The `auto`
 * sentinel is omitted (mirrors CursorCliAdapter.buildArgs) so Cursor picks.
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
  const mobileMcpServers = options.mobileMcp
    ? buildMobileMcpAcpMcpServers(options.mobileMcp)
    : [];
  const inlineMcpServers = buildInlineMcpServersAcpMcpServers(options.mcpConfig);
  const modelArgs: string[] = [];
  const requestedModel = options.model?.trim();
  if (requestedModel && requestedModel.toLowerCase() !== 'auto') {
    modelArgs.push('--model', requestedModel);
  }
  const env = mergeSpawnEnv(options);
  extendEnvWithRtk(env, options.rtk);
  return new AcpCliAdapter({
    adapterName: 'cursor-acp',
    command: 'cursor-agent',
    args: ['acp', ...modelArgs],
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
    concurrencyAcquireTimeoutMs: 60_000,
  });
}

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
  const requestedModel = options.model?.trim();
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
    permissionRegistry: getPermissionRegistry(),
    permissionContext: {
      instanceId: options.instanceId ?? acpEphemeralInstanceId('grok'),
      childId: options.childId,
    },
    concurrencyLimiter: getProviderConcurrencyLimiter(),
    concurrencyKey: 'grok',
    concurrencyAcquireTimeoutMs: 60_000,
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
    // Scaffolding local-first can target a worker node's Ollama directly.
    host: options.ollamaEndpoint?.host,
    port: options.ollamaEndpoint?.port,
  });
}

export function createOpenAICompatibleLocalModelAdapter(
  options: UnifiedSpawnOptions & Pick<
    OpenAICompatibleChatConfig,
    'apiKey' | 'baseUrl' | 'contextWindow' | 'endpointId'
  >,
): OpenAICompatibleChatAdapter {
  return new OpenAICompatibleChatAdapter({
    baseUrl: options.baseUrl,
    endpointId: options.endpointId,
    apiKey: options.apiKey,
    contextWindow: options.contextWindow,
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
  const runtimeTarget = effectiveOptions.modelRuntimeTarget;
  if (effectiveOptions.launchMode === 'interactive') {
    if (cliType !== 'claude') {
      throw new Error('Interactive launch mode is only supported for Claude.');
    }
    throw new Error(INTERACTIVE_RUNTIME_UNAVAILABLE);
  }

  if (runtimeTarget?.kind === 'local-model') {
    if (executionLocation?.type === 'remote') {
      if (runtimeTarget.source !== 'worker-node' || !runtimeTarget.nodeId) {
        throw new Error('Remote local-model execution requires a worker-node runtime target.');
      }
      const connection = getWorkerNodeConnectionServer();
      return new RemoteLocalModelAdapter(connection, {
        ...runtimeTarget,
        source: 'worker-node',
        nodeId: executionLocation.nodeId,
      }, effectiveOptions);
    }

    const localOptions = {
      ...effectiveOptions,
      model: runtimeTarget.modelId,
    };
    if (runtimeTarget.endpointProvider === 'ollama') {
      return createOllamaAdapter(localOptions);
    }
    return createOpenAICompatibleLocalModelAdapter({
      ...localOptions,
      endpointId: runtimeTarget.endpointId,
    });
  }

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
      // Legacy alias — should not normally be reached (resolveCliType maps
      // gemini→antigravity), but kept so any direct `gemini` caller still works.
      return createGeminiAdapter(effectiveOptions);

    case 'antigravity':
      return createAntigravityAdapter(effectiveOptions);

    case 'copilot':
      return createCopilotAdapter(effectiveOptions);

    case 'cursor':
      return createCursorAdapter(effectiveOptions);

    case 'grok':
      return createGrokAdapter(effectiveOptions);

    case 'ollama':
      return createOllamaAdapter(effectiveOptions);

    default:
      throw new Error(`Unknown CLI type: ${cliType}`);
  }
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
      return 'Google Gemini (legacy)';
    case 'antigravity':
      return 'Antigravity';
    case 'copilot':
      return 'GitHub Copilot';
    case 'cursor':
      return 'Cursor CLI';
    case 'grok':
      return 'Grok Build';
    case 'ollama':
      return 'Ollama';
    default:
      return cliType;
  }
}
