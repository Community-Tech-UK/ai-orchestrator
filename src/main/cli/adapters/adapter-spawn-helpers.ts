/**
 * Spawn helpers for the CLI adapter factory.
 *
 * Pure(ish) helper functions and constants extracted from adapter-factory.ts:
 * env construction, RTK PATH wiring, reasoning-effort mapping, system-prompt
 * augmentation, and provider-specific Browser Gateway / chrome-devtools MCP
 * config assembly. The factory module composes these into concrete adapters.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { CodexReasoningEffort } from './codex/app-server-types';
import type { AcpMcpServerConfig } from '../../../shared/types/cli.types';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { getSafeEnvStrict } from '../../security/env-filter';
import {
  buildBrowserGatewayGeminiSettingsJson,
  buildBrowserGatewayMcpConfigJson,
  type BrowserGatewayMcpConfigOptions,
} from '../../browser-gateway/browser-mcp-config';
import {
  buildChromeDevtoolsGeminiSettingsJson,
  buildChromeDevtoolsMcpConfigJson,
} from '../../browser-gateway/chrome-devtools-mcp-config';
import {
  buildMobileMcpGeminiSettingsJson,
  buildMobileMcpConfigJson,
} from '../../browser-gateway/mobile-mcp-config';
import {
  buildComputerUseGeminiSettingsJson,
  COMPUTER_USE_MCP_SERVER_NAME,
  type ComputerUseMcpConfigOptions,
} from '../../desktop-gateway/desktop-mcp-config';
import {
  BROWSER_GATEWAY_SYSTEM_PROMPT,
  CHROME_DEVTOOLS_ATTACH_PROMPT,
  MOBILE_MCP_ATTACH_PROMPT,
  COMPUTER_USE_SYSTEM_PROMPT,
} from './adapter-guidance-prompts';

export const COPILOT_ORCHESTRATOR_HOME_ENV = 'AI_ORCHESTRATOR_COPILOT_HOME';
export const COPILOT_ORCHESTRATOR_HOME_DIR = 'copilot-cli-home';
/** Worker-agent state root override; unset on the Electron controller. */
export const COPILOT_STATE_ROOT_ENV = 'AI_ORCHESTRATOR_STATE_ROOT';

/**
 * Ambient authentication variables removed from every Copilot child.
 *
 * Copilot CLI resolves credentials as
 * `authFindClassicPatEnvVar(COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN)`
 * BEFORE consulting stored OAuth credentials, so any of the first three
 * inherited from the AIO process would override the account the profile home
 * selects. The CLI additionally promotes `GITHUB_COPILOT_GITHUB_TOKEN` into
 * `GITHUB_TOKEN` for its own children and forwards `GITHUB_COPILOT_API_TOKEN`,
 * and `GITHUB_TOKEN_VARNAME` is a name-indirection that can point at any of
 * them — so all six go.
 *
 * `GH_HOST` is deliberately NOT stripped: host selection is
 * `githubGetHost(COPILOT_GH_HOST, GH_HOST)`, and the adapter sets
 * `COPILOT_GH_HOST` from the resolved profile, which outranks it.
 */
export const COPILOT_STRIPPED_AUTH_ENV_VARS = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_COPILOT_GITHUB_TOKEN',
  'GITHUB_COPILOT_API_TOKEN',
  'GITHUB_TOKEN_VARNAME',
] as const;

/**
 * Ambient authentication variables removed from profile-routed Claude children
 * (provider account pools, spec invariant 5).
 *
 * Claude Code's documented precedence puts cloud-provider switches,
 * `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` (always used under `-p`) and
 * `CLAUDE_CODE_OAUTH_TOKEN` ahead of the subscription OAuth that a profile's
 * config dir selects, so any of them inherited from the Harness process would
 * silently turn a profile into a different account or API billing.
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR` decouples the Keychain item from the config
 * dir. `CLAUDE_CONFIG_DIR` itself is on the list so an ambient value cannot
 * leak into a legacy spawn either; a derived route sets it explicitly.
 */
export const CLAUDE_STRIPPED_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
] as const;

/**
 * Ambient authentication variables removed from profile-routed Codex children.
 * An API key or access token outranks the ChatGPT sign-in in the profile's
 * `auth.json`, and `CODEX_SQLITE_HOME` would move state out of the home.
 */
export const CODEX_STRIPPED_AUTH_ENV_VARS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_SQLITE_HOME',
] as const;

/**
 * Generates a synthetic ephemeral instance ID for ACP adapter permission
 * routing when the caller didn't provide one. Keeps the registry-based
 * timeout active for ad-hoc spawns (consensus, verification, auto-title,
 * cross-model review, etc.).
 */
export function acpEphemeralInstanceId(kind: string): string {
  return `acp-ephemeral-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface AcpPermissionContext {
  instanceId: string;
  childId?: string;
  /** When true, session/request_permission is auto-allowed without waiting
   *  for an InstanceManager YOLO lookup. Hidden loop children use ephemeral
   *  instance IDs that are not registered instances, so spawn yoloMode must
   *  travel with the adapter or the permission RPC hangs the prompt turn. */
  yoloMode?: boolean;
}

export function buildAcpPermissionContext(
  options: Pick<UnifiedSpawnOptions, 'instanceId' | 'childId' | 'yoloMode'>,
  kind: string,
): AcpPermissionContext {
  return {
    instanceId: options.instanceId ?? acpEphemeralInstanceId(kind),
    childId: options.childId,
    ...(options.yoloMode === true ? { yoloMode: true } : {}),
  };
}

/**
 * Headless Cursor flags. `--force` alone is not enough: cursor-agent also
 * gates edits/commands behind workspace-trust and MCP-approval prompts, and
 * a missing `--trust` hangs the ACP `session/prompt` until the loop iteration
 * timeout (observed: 0-iteration, 0-token Cursor loops).
 */
export const CURSOR_UNATTENDED_ARGS = [
  '--force',
  '--sandbox',
  'disabled',
  '--trust',
  '--approve-mcps',
] as const;

export function cursorUnattendedArgs(enabled: boolean): string[] {
  return enabled ? [...CURSOR_UNATTENDED_ARGS] : [];
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
export function buildCopilotSpawnEnv(parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
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
  // Removed at CONSTRUCTION, before anything can log this object. A token
  // variable outranks Copilot's stored OAuth credentials, so leaving one in
  // place would silently defeat account routing — the child would authenticate
  // as whoever the ambient token belongs to, whatever profile home it was
  // given. `mergeSpawnEnv`'s secret filter is not a substitute: it only runs
  // when `options.filterEnv` is set, which is true for contained-execution
  // instances alone.
  for (const key of COPILOT_STRIPPED_AUTH_ENV_VARS) {
    delete env[key];
  }
  env['NODE_OPTIONS'] = merged;
  return env;
}

/**
 * Electron's userData directory, or `undefined` outside Electron (tests, the
 * worker agent). Exported so the Copilot profile-home resolver derives its
 * profiles root from the same base as the legacy home rather than a second,
 * drifting copy of this lookup.
 */
export function getElectronUserDataPath(): string | undefined {
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

/**
 * Root directory that provider CLI state (Copilot homes, Claude and Codex
 * account-profile homes) lives under.
 *
 * Order matters:
 *   1. `AI_ORCHESTRATOR_STATE_ROOT` — set by the WORKER AGENT, which runs
 *      outside Electron and whose state belongs in `~/.orchestrator` rather
 *      than a temp directory that a reboot clears (which would silently
 *      un-sign-in every Copilot account on that node).
 *   2. Electron's userData — the controller.
 *   3. A temp fallback for tests and any other non-Electron context.
 *
 * Unset on the controller, so controller behaviour is byte-identical to before
 * this variable existed.
 */
export function getProviderStateRoot(parent: NodeJS.ProcessEnv = process.env): string {
  const workerRoot = parent[COPILOT_STATE_ROOT_ENV]?.trim();
  if (workerRoot) {
    return workerRoot;
  }
  return getElectronUserDataPath() ?? join(tmpdir(), 'ai-orchestrator');
}

/** Copilot's state root. Same resolution as {@link getProviderStateRoot}. */
export function getCopilotStateRoot(parent: NodeJS.ProcessEnv = process.env): string {
  return getProviderStateRoot(parent);
}

export function getCopilotOrchestratorHome(parent: NodeJS.ProcessEnv = process.env): string {
  const explicit = parent[COPILOT_ORCHESTRATOR_HOME_ENV]?.trim();
  const homeDir = explicit || join(getCopilotStateRoot(parent), COPILOT_ORCHESTRATOR_HOME_DIR);
  try {
    mkdirSync(homeDir, { recursive: true });
  } catch (error) {
    // Same reasoning as the per-profile resolver: a raw fs error embeds the
    // real path, and this throw reaches surfaces that do not scrub it (mobile
    // gateway responses, Discord channel messages).
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `Could not prepare the Copilot home directory${code ? ` (${code})` : ''}.`
      + ' Check the Harness data directory is writable.',
    );
  }
  return homeDir;
}

export function withBrowserGatewayProvider(
  options: BrowserGatewayMcpConfigOptions,
  provider: string,
): BrowserGatewayMcpConfigOptions {
  return {
    ...options,
    provider: options.provider ?? provider,
  };
}

/**
 * True when the spawn carries a Harness Computer Use bridge — either the
 * dedicated {@link UnifiedSpawnOptions.computerUseMcp} option or a `computer-use`
 * server already present in the inline `mcpConfig` (which the spawn-config
 * builder injects for all providers). Lets the system-prompt / Gemini-settings
 * helpers react without every spawn site populating the dedicated option.
 */
function hasComputerUseBridge(options: UnifiedSpawnOptions): boolean {
  if (options.computerUseMcp) {
    return true;
  }
  return hasInlineMcpServerConfig(options.mcpConfig ?? [], COMPUTER_USE_MCP_SERVER_NAME);
}

export function withComputerUseProvider(
  options: ComputerUseMcpConfigOptions,
  provider: string,
): ComputerUseMcpConfigOptions {
  return {
    ...options,
    provider: options.provider ?? provider,
  };
}

export type AdapterGuidanceBlockKind =
  | 'adapter-browser-gateway'
  | 'adapter-chrome-devtools'
  | 'adapter-mobile-mcp'
  | 'adapter-computer-use';

export interface AdapterGuidanceBlock {
  kind: AdapterGuidanceBlockKind;
  content: string;
}

/** The exact blocks this adapter will append to the supplied system prompt. */
export function getAdapterGuidanceBlocks(options: UnifiedSpawnOptions): AdapterGuidanceBlock[] {
  const computerUse = hasComputerUseBridge(options);
  if (!options.browserGatewayMcp && !options.chromeDevtoolsMcp && !options.mobileMcp && !computerUse) {
    return [];
  }
  const existingPrompt = options.systemPrompt?.trim() ?? '';
  const blocks: AdapterGuidanceBlock[] = [];
  if (
    options.browserGatewayMcp &&
    !existingPrompt.includes('[Browser Gateway]') &&
    !existingPrompt.includes('browser.find_or_open')
  ) {
    blocks.push({ kind: 'adapter-browser-gateway', content: BROWSER_GATEWAY_SYSTEM_PROMPT });
  }
  if (
    options.chromeDevtoolsMcp &&
    !existingPrompt.includes('[chrome-devtools attached to a managed browser profile]')
  ) {
    blocks.push({ kind: 'adapter-chrome-devtools', content: CHROME_DEVTOOLS_ATTACH_PROMPT });
  }
  if (
    options.mobileMcp &&
    !existingPrompt.includes('[mobile-mcp attached to a leased Android device]')
  ) {
    blocks.push({ kind: 'adapter-mobile-mcp', content: MOBILE_MCP_ATTACH_PROMPT });
  }
  if (
    computerUse &&
    !existingPrompt.includes('[Harness Computer Use]')
  ) {
    blocks.push({ kind: 'adapter-computer-use', content: COMPUTER_USE_SYSTEM_PROMPT });
  }
  return blocks;
}

export function withBrowserGatewaySystemPrompt(options: UnifiedSpawnOptions): UnifiedSpawnOptions {
  const blocks = getAdapterGuidanceBlocks(options);
  if (blocks.length === 0) return options;
  const sections = [options.systemPrompt?.trim() ?? '', ...blocks.map((block) => block.content)];
  return {
    ...options,
    systemPrompt: sections.filter(Boolean).join('\n\n---\n\n'),
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
export function extendEnvWithRtk(
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

export function toCodexReasoningEffort(
  reasoningEffort: UnifiedSpawnOptions['reasoningEffort'],
): CodexReasoningEffort | undefined {
  if (reasoningEffort === 'workflow') {
    return undefined;
  }
  return reasoningEffort;
}

export function mergeSpawnEnv(options: UnifiedSpawnOptions, base: Record<string, string> = {}): Record<string, string> {
  const merged = {
    ...base,
    ...(options.env ?? {}),
  };
  // WS-C7: a contained-execution-profile spawn derives its environment from
  // getSafeEnvStrict() (src/main/security/env-filter.ts) — the host env AND any
  // caller-supplied `options.env` both pass through the secret filter, so no
  // API keys, tokens, or other blocked values (including AI-provider keys) can
  // reach the child process from either source.
  if (options.filterEnv) {
    return getSafeEnvStrict(merged);
  }
  return merged;
}

function mergeGeminiMcpServers(json: string | null, into: Record<string, unknown>): void {
  if (!json) {
    return;
  }
  const parsed = JSON.parse(json) as { mcpServers?: Record<string, unknown> };
  Object.assign(into, parsed.mcpServers ?? {});
}

/**
 * Merge the Harness Computer Use MCP server into a Gemini settings object.
 *
 * Gemini reads MCP servers from a settings.json file rather than inline JSON,
 * so the `computer-use` server the spawn-config builder pushes onto `mcpConfig`
 * (consumed directly by Claude/Codex/Copilot) would otherwise be dropped for
 * Gemini. Prefer the dedicated {@link UnifiedSpawnOptions.computerUseMcp}
 * option; otherwise recover the already-built server spec from the inline
 * `mcpConfig` so injection works even when only the inline path is populated.
 */
function mergeComputerUseGeminiSettings(
  options: UnifiedSpawnOptions,
  into: Record<string, unknown>,
): void {
  if (options.computerUseMcp) {
    mergeGeminiMcpServers(
      buildComputerUseGeminiSettingsJson(
        withComputerUseProvider(options.computerUseMcp, 'gemini'),
      ),
      into,
    );
    return;
  }
  for (const entry of options.mcpConfig ?? []) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { mcpServers?: Record<string, unknown> };
      const server = parsed.mcpServers?.[COMPUTER_USE_MCP_SERVER_NAME];
      if (server) {
        into[COMPUTER_USE_MCP_SERVER_NAME] = server;
      }
    } catch {
      // Ignore malformed inline entries; other providers validate separately.
    }
  }
}

export function writeGeminiBrowserGatewaySettings(
  options: UnifiedSpawnOptions,
): string | undefined {
  const mcpServers: Record<string, unknown> = {};
  if (options.browserGatewayMcp) {
    mergeGeminiMcpServers(
      buildBrowserGatewayGeminiSettingsJson(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'gemini'),
      ),
      mcpServers,
    );
  }
  if (options.chromeDevtoolsMcp) {
    mergeGeminiMcpServers(
      buildChromeDevtoolsGeminiSettingsJson(options.chromeDevtoolsMcp),
      mcpServers,
    );
  }
  if (options.mobileMcp) {
    mergeGeminiMcpServers(
      buildMobileMcpGeminiSettingsJson(options.mobileMcp),
      mcpServers,
    );
  }
  mergeComputerUseGeminiSettings(options, mcpServers);
  if (Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ai-orchestrator-gemini-browser-mcp-'));
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ mcpServers }), 'utf-8');
  return settingsPath;
}

export function buildCopilotAdditionalMcpConfig(
  servers: AcpMcpServerConfig[],
): string | undefined {
  if (servers.length === 0) {
    return undefined;
  }

  return JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        {
          command: server.command,
          ...(server.args ? { args: server.args } : {}),
          ...(server.env ? {
            env: Object.fromEntries(
              server.env.map(({ name, value }) => [name, value]),
            ),
          } : {}),
        },
      ]),
    ),
  });
}

const DEDICATED_ACP_BRIDGE_SERVERS = new Set([
  'browser-gateway',
  'chrome-devtools',
  'mobile-mcp',
  'maestro',
]);

interface InlineJsonMcpServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

function toAcpMcpServer(name: string, server: InlineJsonMcpServer): AcpMcpServerConfig | null {
  if (typeof server.command !== 'string' || !server.command.trim()) {
    return null;
  }
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : undefined;
  const env = server.env &&
    typeof server.env === 'object' &&
    !Array.isArray(server.env)
    ? Object.entries(server.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([envName, value]) => ({ name: envName, value }))
    : undefined;
  return {
    name,
    command: server.command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(env && env.length > 0 ? { env } : {}),
  };
}

export function buildInlineMcpServersAcpMcpServers(
  mcpConfigEntries: string[] | undefined,
): AcpMcpServerConfig[] {
  if (!mcpConfigEntries?.length) {
    return [];
  }

  const servers = new Map<string, AcpMcpServerConfig>();
  for (const entry of mcpConfigEntries) {
    const trimmed = entry.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }

    let parsed: { mcpServers?: Record<string, InlineJsonMcpServer> };
    try {
      parsed = JSON.parse(trimmed) as { mcpServers?: Record<string, InlineJsonMcpServer> };
    } catch {
      continue;
    }

    for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
      if (DEDICATED_ACP_BRIDGE_SERVERS.has(name)) {
        continue;
      }
      const acpServer = toAcpMcpServer(name, server);
      if (acpServer) {
        servers.set(name, acpServer);
      }
    }
  }

  return [...servers.values()];
}

function hasInlineMcpServerConfig(configs: string[], serverName: string): boolean {
  return configs.some((config) => {
    try {
      const parsed = JSON.parse(config) as { mcpServers?: unknown };
      const mcpServers = parsed.mcpServers;
      return Boolean(
        mcpServers &&
        typeof mcpServers === 'object' &&
        Object.prototype.hasOwnProperty.call(mcpServers, serverName)
      );
    } catch {
      return false;
    }
  });
}

/**
 * Claude Code requires `type: 'http' | 'sse'` for remote MCP servers. Older
 * Harness config producers used the generic `transport` field instead, which
 * makes Claude silently skip the server. Normalize only inline JSON because
 * file paths are intentionally handed to the CLI unchanged.
 */
function normalizeClaudeInlineMcpConfig(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed.startsWith('{')) {
    return entry;
  }

  try {
    const parsed = JSON.parse(trimmed) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return entry;
    }

    let changed = false;
    const mcpServers = Object.fromEntries(Object.entries(parsed.mcpServers).map(([name, server]) => {
      if (!server || typeof server !== 'object' || Array.isArray(server)) {
        return [name, server];
      }
      const definition = server as Record<string, unknown>;
      const transport = definition['transport'];
      if (
        definition['type'] !== undefined
        || (transport !== 'http' && transport !== 'sse')
      ) {
        return [name, server];
      }
      const { transport: _transport, ...withoutTransport } = definition;
      changed = true;
      return [name, { ...withoutTransport, type: transport }];
    }));

    return changed ? JSON.stringify({ ...parsed, mcpServers }) : entry;
  } catch {
    return entry;
  }
}

export function buildClaudeMcpConfig(options: UnifiedSpawnOptions): string[] | undefined {
  const configs = (options.mcpConfig ?? []).map(normalizeClaudeInlineMcpConfig);
  const browserGatewayConfig = options.browserGatewayMcp
    ? buildBrowserGatewayMcpConfigJson(
        withBrowserGatewayProvider(options.browserGatewayMcp, 'claude'),
      )
    : null;
  if (
    browserGatewayConfig
    && !hasInlineMcpServerConfig(configs, 'browser-gateway')
  ) {
    configs.push(browserGatewayConfig);
  }
  // chrome-devtools attach is normally already present via getMcpConfig() (the
  // spawn config builder pushes the inline JSON). Add it from the dedicated
  // option as a fallback, deduping on the server key so it is never doubled.
  const chromeDevtoolsConfig = options.chromeDevtoolsMcp
    ? buildChromeDevtoolsMcpConfigJson(options.chromeDevtoolsMcp)
    : null;
  if (
    chromeDevtoolsConfig
    && !hasInlineMcpServerConfig(configs, 'chrome-devtools')
  ) {
    configs.push(chromeDevtoolsConfig);
  }
  const mobileMcpConfig = options.mobileMcp
    ? buildMobileMcpConfigJson(options.mobileMcp)
    : null;
  if (
    mobileMcpConfig
    && !hasInlineMcpServerConfig(configs, 'mobile-mcp')
  ) {
    configs.push(mobileMcpConfig);
  }
  return configs.length > 0 ? configs : undefined;
}
