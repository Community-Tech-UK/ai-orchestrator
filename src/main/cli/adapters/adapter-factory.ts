/**
 * CLI Adapter Factory - Creates appropriate CLI adapters based on provider type
 *
 * Centralizes adapter instantiation to support multiple CLI providers:
 * - Claude Code CLI
 * - OpenAI Codex CLI
 * - Google Gemini CLI
 * - Ollama (future)
 */

import { ClaudeCliAdapter, ClaudeCliSpawnOptions } from './claude-cli-adapter';
import { CodexCliAdapter, CodexCliConfig } from './codex-cli-adapter';
import { GeminiCliAdapter, GeminiCliConfig } from './gemini-cli-adapter';
import { AcpCliAdapter } from './acp-cli-adapter';
import { RemoteCliAdapter } from './remote-cli-adapter';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
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
  buildBrowserGatewayGeminiSettingsJson,
  type BrowserGatewayMcpConfigOptions,
} from '../../browser-gateway/browser-mcp-config';
import type { AcpMcpServerConfig } from '../../../shared/types/cli.types';

const logger = getLogger('AdapterFactory');

const COPILOT_ORCHESTRATOR_HOME_ENV = 'AI_ORCHESTRATOR_COPILOT_HOME';
const COPILOT_ORCHESTRATOR_HOME_DIR = 'copilot-cli-home';

/**
 * Unified spawn options that work across all adapters
 */
export interface UnifiedSpawnOptions {
  /** Run without persisting provider session/thread state (provider-specific). */
  ephemeral?: boolean;
  sessionId?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  timeout?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: boolean;  // Resume an existing session (requires sessionId)
  forkSession?: boolean; // Fork a resumed session into a new session ID (Claude CLI)
  mcpConfig?: string[];  // MCP server config file paths or inline JSON strings
  /** ACP-native MCP server configs supplied by the caller. */
  mcpServers?: AcpMcpServerConfig[];
  /** Browser Gateway bridge options used to build provider-specific MCP config. */
  browserGatewayMcp?: BrowserGatewayMcpConfigOptions;
  /** Enable Chrome extension integration (Claude CLI only).
   *  Defaults to false; managed browser access is exposed through Browser Gateway MCP. */
  chrome?: boolean;
  /** JSON Schema object for structured output (Codex app-server mode). */
  outputSchema?: Record<string, unknown>;
  /** Reasoning effort level for the model (Codex: none → xhigh, Claude: low → high). */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Minimal mode (Claude CLI only): skip hooks, LSP, plugins for faster startup.
   *  Requires explicit API key — OAuth/keychain auth is skipped. Defaults to false. */
  bare?: boolean;
  /** Display name for this session (Claude CLI only). Shown in /resume picker. */
  name?: string;
  /** Improve prompt-cache hit rates by moving per-machine system prompt sections
   *  into the first user message (Claude CLI only). Defaults to true for orchestrated spawns. */
  excludeDynamicSystemPromptSections?: boolean;
  /** Path to a PreToolUse hook script for defer-based permission approval (Claude CLI only).
   *  When set, the adapter injects hook configuration via --settings to intercept dangerous
   *  tools and return `defer`, pausing execution for user approval. */
  permissionHookPath?: string;
  /** Optional RTK rewrite integration (Claude CLI only in v1).
   *  When set with `enabled: true` and a resolved `binaryPath`, the spawned CLI gets
   *  ORCHESTRATOR_RTK_ENABLED=1 / ORCHESTRATOR_RTK_PATH in its env so the
   *  combined rtk-defer-hook.mjs can call `rtk rewrite` on Bash tool input.
   *  See bigchange_rtk_integration.md. */
  rtk?: {
    enabled: boolean;
    binaryPath?: string;
  };
  /** Instance ID, used by ACP-backed adapters (Copilot, Cursor) to tag
   *  permission requests routed through `PermissionRegistry`. When omitted,
   *  the factory generates a synthetic ephemeral ID so the registry's
   *  auto-timeout still fires on unresponded `session/request_permission`
   *  RPCs (otherwise the ACP turn would hang indefinitely). */
  instanceId?: string;
  /** Child ID for nested / subagent instances (ACP permission context). */
  childId?: string;
}

/**
 * Generates a synthetic ephemeral instance ID for ACP adapter permission
 * routing when the caller didn't provide one. Keeps the registry-based
 * timeout active for ad-hoc spawns (consensus, verification, auto-title,
 * cross-model review, etc.).
 */
function acpEphemeralInstanceId(kind: string): string {
  return `acp-ephemeral-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * macOS-only workaround for a Node.js SIGSEGV in
 * `node::crypto::ReadMacOSKeychainCertificates` → `CFArrayGetCount`,
 * observed crashing Copilot CLI children on macOS 26 (Tahoe-era) under
 * ai-orchestrator. The flag tells the embedded Node runtime to use the
 * OpenSSL-bundled CA store and skip the keychain read, sidestepping the bug.
 *
 * Safe on all platforms (no-op on non-macOS), so applied unconditionally
 * to the Copilot spawn env. Preserves any pre-existing NODE_OPTIONS the
 * user has set.
 */
function buildCopilotSpawnEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const existingNodeOptions = parent['NODE_OPTIONS']?.trim() ?? '';
  const flag = '--use-openssl-ca';
  const merged = existingNodeOptions.includes(flag)
    ? existingNodeOptions
    : [existingNodeOptions, flag].filter(Boolean).join(' ');

  // Strip undefined values from ProcessEnv — `CliAdapterConfig.env` requires
  // a strict `Record<string, string>`. Node's ProcessEnv allows `undefined`
  // entries (uninitialized keys), which TypeScript rejects at the consumer.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  env['NODE_OPTIONS'] = merged;
  return env;
}

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: { getPath?: (name: string) => string };
    };
    const userDataPath = electron.app?.getPath?.('userData');
    return typeof userDataPath === 'string' && userDataPath.trim()
      ? userDataPath
      : undefined;
  } catch {
    return undefined;
  }
}

function getCopilotOrchestratorHome(parent: NodeJS.ProcessEnv = process.env): string {
  const explicit = parent[COPILOT_ORCHESTRATOR_HOME_ENV]?.trim();
  const homeDir = explicit || join(
    getElectronUserDataPath() ?? join(tmpdir(), 'ai-orchestrator'),
    COPILOT_ORCHESTRATOR_HOME_DIR
  );
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

function withBrowserGatewayProvider(
  options: BrowserGatewayMcpConfigOptions,
  provider: string,
): BrowserGatewayMcpConfigOptions {
  return {
    ...options,
    provider: options.provider ?? provider,
  };
}

/**
 * Prepend the directory containing the resolved rtk binary onto PATH so the
 * model's shell tool can invoke `rtk <cmd>` and find the bundled binary even
 * when the user hasn't installed rtk system-wide. Mutates and returns `env`.
 *
 * Also sets `RTK_TELEMETRY_DISABLED=1` so child invocations of `rtk` don't
 * leak usage data. Both env vars are belt-and-braces — ineffective when
 * options.rtk is absent, so callers can call this unconditionally.
 */
function extendEnvWithRtk(
  env: Record<string, string>,
  rtk: UnifiedSpawnOptions['rtk'],
): Record<string, string> {
  if (!rtk?.enabled || !rtk.binaryPath) return env;
  const rtkDir = dirname(rtk.binaryPath);
  const currentPath = env['PATH'] ?? process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = currentPath ? currentPath.split(sep) : [];
  if (!parts.includes(rtkDir)) {
    env['PATH'] = [rtkDir, ...parts].join(sep);
  }
  env['RTK_TELEMETRY_DISABLED'] = '1';
  return env;
}

function writeGeminiBrowserGatewaySettings(
  options: BrowserGatewayMcpConfigOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  const settingsJson = buildBrowserGatewayGeminiSettingsJson(
    withBrowserGatewayProvider(options, 'gemini'),
  );
  if (!settingsJson) {
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ai-orchestrator-gemini-browser-mcp-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, settingsJson, 'utf-8');
  return settingsPath;
}

/**
 * Adapter type union - the concrete adapter types
 */
export type CliAdapter = ClaudeCliAdapter | CodexCliAdapter | GeminiCliAdapter | AcpCliAdapter | RemoteCliAdapter;

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
    yoloMode: options.yoloMode,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    resume: options.resume,
    forkSession: options.forkSession,
    mcpConfig: options.mcpConfig,
    reasoningEffort: options.reasoningEffort,
    bare: options.bare,
    name: options.name,
    // Default prompt-section exclusion to true for orchestrated instances —
    // they share similar prompts and benefit from cross-instance cache hits.
    excludeDynamicSystemPromptSections: options.excludeDynamicSystemPromptSections ?? true,
    chrome: options.chrome,
    permissionHookPath: options.permissionHookPath,
    rtk: options.rtk,
  };
  return new ClaudeCliAdapter(claudeOptions);
}

/**
 * Creates a Codex CLI adapter
 */
export function createCodexAdapter(options: UnifiedSpawnOptions): CodexCliAdapter {
  const mcpServersConfigToml = options.browserGatewayMcp
    ? buildBrowserGatewayCodexConfigToml(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'codex'),
      )
    : null;
  const codexEnv: Record<string, string> = {};
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
    reasoningEffort: options.reasoningEffort,
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
  const browserGatewaySettingsPath = writeGeminiBrowserGatewaySettings(options.browserGatewayMcp);
  const env: Record<string, string> = {};
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
  const env = buildCopilotSpawnEnv();
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
    ],
    workingDirectory: options.workingDirectory ?? process.cwd(),
    sessionId: options.sessionId,
    resume: options.resume,
    env,
    mcpServers: [
      ...(options.mcpServers ?? []),
      ...browserGatewayMcpServers,
    ],
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
  const env: Record<string, string> = {};
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
 * Creates a CLI adapter for the specified type
 * Returns a ClaudeCliAdapter for Claude, or the appropriate adapter for other types
 */
export function createCliAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions,
  executionLocation?: ExecutionLocation,
): CliAdapter {
  // If remote, create a RemoteCliAdapter regardless of CLI type
  if (executionLocation?.type === 'remote') {
    const connection = getWorkerNodeConnectionServer();
    return new RemoteCliAdapter(connection, executionLocation.nodeId, cliType, options);
  }

  switch (cliType) {
    case 'claude':
      return createClaudeAdapter(options);

    case 'codex':
      return createCodexAdapter(options);

    case 'gemini':
      return createGeminiAdapter(options);

    case 'copilot':
      return createCopilotAdapter(options);

    case 'cursor':
      return createCursorAdapter(options);

    case 'ollama':
      // Ollama doesn't have a full CLI adapter yet, fall back to Claude
      logger.warn('Ollama adapter not implemented, falling back to Claude');
      return createClaudeAdapter(options);

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
