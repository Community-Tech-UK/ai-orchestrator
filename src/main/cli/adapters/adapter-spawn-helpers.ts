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
  type ComputerUseMcpConfigOptions,
} from '../../desktop-gateway/desktop-mcp-config';

export const COPILOT_ORCHESTRATOR_HOME_ENV = 'AI_ORCHESTRATOR_COPILOT_HOME';
export const COPILOT_ORCHESTRATOR_HOME_DIR = 'copilot-cli-home';

const BROWSER_GATEWAY_SYSTEM_PROMPT = [
  '[Browser Gateway]',
  'When the user asks you to use a website, browser tab, authenticated session, web form, or page state, use the browser.* tools directly.',
  'Do not use Browser Gateway managed profiles for authenticated user sessions. They are separate Harness-controlled Chrome profiles and do not share the user\'s normal browser cookies.',
  'Start with browser.find_or_open using the best URL and/or title hint. It can find existing authenticated Chrome tabs first and open a new tab when no matching tab exists.',
  'If the user says the authenticated page is already open but Browser Gateway cannot see it, ask the user to share the current tab through the Browser Gateway extension, then retry browser.find_or_open or browser.list_targets.',
  'Do not ask the user to copy/paste page content, take screenshots, or gather browser data manually until the share-tab handoff has been tried.',
  'Then use browser.snapshot, browser.screenshot, browser.wait_for, browser.click, browser.type, browser.fill_form, and browser.select as needed.',
  'To read back the current state of a control (e.g. verify which option a <select> dropdown shows, or whether a checkbox is checked), use browser.query_elements: each candidate reports its current value, the selected option label, the full option list for a <select>, and checked state.',
  'For login, captcha, two-factor, destructive, submit, credential, or unclear actions, use the Browser Gateway approval/manual-step tools instead of guessing.',
  'Do not tell the user to open /browser. /browser is only a Browser Gateway diagnostics and approval page, not the user browser.',
  'Tool routing: browser.* is the ONLY way to reach the user\'s real authenticated everyday Chrome tabs (it shares their real cookies). Use it for any task that needs the user\'s existing logged-in session.',
  'If chrome-devtools.* tools are available, prefer them for work that does NOT need the user\'s existing session — throwaway automation, sites where you can sign in yourself, or deep inspection (exact DOM values, accessibility tree, console, network, performance). They expose richer read-back (take_snapshot from the a11y tree, evaluate_script, network/console/perf) than browser.*.',
  'chrome-devtools.* drives a SEPARATE Chrome instance and cannot see the user\'s shared authenticated tabs, so never try to hand a browser.* authenticated tab over to chrome-devtools.*. The two tools control different browsers.',
].join('\n');

const CHROME_DEVTOOLS_ATTACH_PROMPT = [
  '[chrome-devtools attached to a managed browser profile]',
  'The chrome-devtools.* tools are attached to a Harness-managed Chrome profile — the SAME browser the browser.* tools open and control. This is the one case where browser.* and chrome-devtools.* share a browser.',
  'Workflow: first open and sign into the managed profile with browser.find_or_open (complete any login), THEN use chrome-devtools.* — it connects to that same live browser on first tool use, so the profile must be open first.',
  'If a chrome-devtools.* tool reports it cannot connect to a browser, the managed profile is not running yet: open it via browser.* first, then retry.',
  'For accessibility scans on worker-managed browser sessions, run `$AIO_AXE_RUNNER --browser-url "$AIO_BROWSER_URL" --page-url <url>`.',
].join('\n');

const MOBILE_MCP_ATTACH_PROMPT = [
  '[mobile-mcp attached to a leased Android device]',
  'Use mobile-mcp tools for Android testing only against the leased serial named in the Android device lease section.',
  'Every mobile tool call must pass that serial as its `device` parameter.',
].join('\n');

const COMPUTER_USE_SYSTEM_PROMPT = [
  '[Harness Computer Use]',
  'When the user asks you to observe or control a desktop application (not a web page), use the computer.* tools.',
  'Always call computer.health first. If it reports the driver is unhealthy or missing macOS permissions (Screen Recording / Accessibility), report the exact setupActions to the user and use computer.raise_escalation instead of attempting observe/input actions.',
  'Discover targets with computer.list_apps, then request access with computer.request_app_grant and wait for approval (poll computer.get_approval_status). You may only observe or control an app the user has explicitly granted.',
  'Before any input action (click, type_text, hotkey, scroll, drag) you MUST first capture a fresh observation and pass its observationToken. Use computer.accessibility_snapshot for click, type_text, scroll, and drag so targets can be bound to accessibility elements or coordinates inside observed app bounds. Tokens are single-app, time-bounded, and invalidated when the focused window changes.',
  'Use computer.query_elements against the accessibility observation token to locate UI elements by role/label/text. When an elementUid is supplied, Harness ignores caller coordinates and uses the observed element center. Coordinate clicks, scrolls, and both drag endpoints must remain inside observed app bounds.',
  'For login, credential entry, payment, destructive, or otherwise sensitive actions, use computer.raise_escalation and let the user complete the step; never type passwords or secrets yourself.',
  'Certain apps (the Harness itself, terminals, password managers, Keychain, System Settings security panes, provider apps) are hard-denied and can never be controlled — do not attempt to work around a denial.',
  'Use computer.list_grants and computer.revoke_grant to review and clean up access you no longer need.',
].join('\n');

/**
 * Generates a synthetic ephemeral instance ID for ACP adapter permission
 * routing when the caller didn't provide one. Keeps the registry-based
 * timeout active for ad-hoc spawns (consensus, verification, auto-title,
 * cross-model review, etc.).
 */
export function acpEphemeralInstanceId(kind: string): string {
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

export function getCopilotOrchestratorHome(parent: NodeJS.ProcessEnv = process.env): string {
  const explicit = parent[COPILOT_ORCHESTRATOR_HOME_ENV]?.trim();
  const homeDir = explicit || join(
    getElectronUserDataPath() ?? join(tmpdir(), 'ai-orchestrator'),
    COPILOT_ORCHESTRATOR_HOME_DIR
  );
  mkdirSync(homeDir, { recursive: true });
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
  return hasInlineMcpServerConfig(options.mcpConfig ?? [], 'computer-use');
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

export function withBrowserGatewaySystemPrompt(options: UnifiedSpawnOptions): UnifiedSpawnOptions {
  const computerUse = hasComputerUseBridge(options);
  if (!options.browserGatewayMcp && !options.chromeDevtoolsMcp && !options.mobileMcp && !computerUse) {
    return options;
  }
  const existingPrompt = options.systemPrompt?.trim() ?? '';
  const sections = [existingPrompt];
  if (
    options.browserGatewayMcp &&
    !existingPrompt.includes('[Browser Gateway]') &&
    !existingPrompt.includes('browser.find_or_open')
  ) {
    sections.push(BROWSER_GATEWAY_SYSTEM_PROMPT);
  }
  if (
    options.chromeDevtoolsMcp &&
    !existingPrompt.includes('[chrome-devtools attached to a managed browser profile]')
  ) {
    sections.push(CHROME_DEVTOOLS_ATTACH_PROMPT);
  }
  if (
    options.mobileMcp &&
    !existingPrompt.includes('[mobile-mcp attached to a leased Android device]')
  ) {
    sections.push(MOBILE_MCP_ATTACH_PROMPT);
  }
  if (
    computerUse &&
    !existingPrompt.includes('[Harness Computer Use]')
  ) {
    sections.push(COMPUTER_USE_SYSTEM_PROMPT);
  }
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
  return {
    ...base,
    ...(options.env ?? {}),
  };
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
      const server = parsed.mcpServers?.['computer-use'];
      if (server) {
        into['computer-use'] = server;
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

export function buildClaudeMcpConfig(options: UnifiedSpawnOptions): string[] | undefined {
  const configs = [...(options.mcpConfig ?? [])];
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
