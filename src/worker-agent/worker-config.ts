import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * Opt-in browser automation for a worker node. When enabled, the worker owns a
 * single Chrome launched with remote debugging against a dedicated profile, and
 * injects a `chrome-devtools` MCP server (attached via `--browserUrl`) into every
 * CLI instance it spawns — giving remote agents `mcp__chrome-devtools__*` tools.
 *
 * SECURITY: chrome-devtools-mcp has no approval/grant/audit layer. Only enable on
 * trusted, owned nodes, and point `profileDir` at a DEDICATED automation profile
 * (logged into only the sites the agent should touch) — never the user's everyday
 * Chrome profile.
 */
export interface WorkerBrowserAutomationConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /**
   * Chrome `--user-data-dir` for the dedicated automation profile. Chrome locks
   * a user-data-dir to one process, so this MUST NOT be the directory the user's
   * everyday Chrome is running from. Defaults to
   * `~/.orchestrator/browser-automation-profile`.
   */
  profileDir?: string;
  /**
   * Launch Chrome headless (`--headless=new`). Default false — headful is fine on
   * an unattended node and some sites behave differently headless.
   */
  headless?: boolean;
  /** Override the Chrome executable path; auto-detected when omitted. */
  chromePath?: string;
  /**
   * Fixed remote-debugging port for the managed Chrome. Default 0 → pick an
   * ephemeral free port at launch (avoids collisions with the user's own Chrome).
   */
  remoteDebuggingPort?: number;
}

/**
 * Opt-in Android automation for a worker node. When enabled, the worker can
 * lease exactly one Android serial per spawned instance and inject mobile-mcp.
 *
 * SECURITY: leases are advisory because spawned agents still have shell access
 * to adb. Enable only on trusted, owned nodes and keep personal devices
 * unplugged unless they are intentionally part of the test pool.
 */
export interface WorkerAndroidAutomationConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Android SDK root override. Defaults to ANDROID_HOME/ANDROID_SDK_ROOT/platform paths. */
  sdkPath?: string;
  /** Default AVD name for emulator-backed leases. */
  defaultAvd?: string;
  /** Launch emulators without a window. Default true. */
  headlessEmulator?: boolean;
  /** Maximum managed emulator processes. Default 1, capped at 4. */
  maxEmulators?: number;
  /** Emulator boot wait budget. Default 180 seconds. */
  bootTimeoutMs?: number;
  /** Whether USB/Wi-Fi devices can be leased. Default true. */
  allowPhysicalDevices?: boolean;
  /** Inject Maestro MCP in addition to mobile-mcp when Maestro is detected. */
  injectMaestroMcp?: boolean;
  /** Reserved opt-in for future Appium MCP wiring. */
  appiumMcp?: boolean;
  /** mobile-mcp package version. Defaults to the pinned builder version. */
  mobileMcpVersion?: string;
}

export interface WorkerExtensionRelayConfig {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Worker-local socket/pipe path for the browser native host to connect to. */
  socketPath?: string;
  /** Worker-local native-host token. Generated locally; never sent by coordinator config. */
  extensionToken?: string;
}

export interface WorkerConfig {
  nodeId: string;
  name: string;
  coordinatorUrl?: string;
  /**
   * Additional coordinator URLs tried, in order, when `coordinatorUrl` is
   * unreachable. Lets a worker survive the host's LAN IP changing by pairing a
   * stable Tailscale name alongside the LAN address, without relying on mDNS.
   */
  coordinatorUrls?: string[];
  authToken: string;
  nodeToken?: string;
  recoveryToken?: string;
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  reconnectIntervalMs: number;
  heartbeatIntervalMs: number;
  /** Opt-in browser automation (default disabled). */
  browserAutomation?: WorkerBrowserAutomationConfig;
  /** Opt-in Android automation (default disabled). */
  androidAutomation?: WorkerAndroidAutomationConfig;
  /** Opt-in remote existing-tab relay through the Chrome extension (default disabled). */
  extensionRelay?: WorkerExtensionRelayConfig;
}

interface PairingConfigFile {
  token?: unknown;
  host?: unknown;
  port?: unknown;
  requireTls?: unknown;
}

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.orchestrator', 'worker-node.json');

const DEFAULTS: WorkerConfig = {
  nodeId: '',
  name: os.hostname(),
  coordinatorUrl: undefined,
  authToken: '',
  nodeToken: undefined,
  namespace: 'default',
  maxConcurrentInstances: 10,
  workingDirectories: [],
  reconnectIntervalMs: 5_000,
  heartbeatIntervalMs: 10_000,
};

/**
 * Load worker config from disk. Creates a default config file on first run.
 * CLI flags override file values: --coordinator, --name, --token.
 */
export function loadWorkerConfig(configPath = DEFAULT_CONFIG_PATH): WorkerConfig {
  let fileConfig: Partial<WorkerConfig> = {};

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = normalizeFileConfig(JSON.parse(raw) as Partial<WorkerConfig> & PairingConfigFile);
  }

  const merged: WorkerConfig = { ...DEFAULTS, ...fileConfig };

  // Generate stable nodeId on first run
  if (!merged.nodeId) {
    merged.nodeId = crypto.randomUUID();
  }
  merged.extensionRelay = ensureExtensionRelayDefaults(
    merged.extensionRelay,
    defaultExtensionRelaySocketPath,
  );

  // Apply CLI overrides
  const args = parseCliArgs(process.argv.slice(2));
  if (args['coordinator']) merged.coordinatorUrl = args['coordinator'];
  if (args['name']) merged.name = args['name'];
  if (args['namespace']) merged.namespace = args['namespace'];
  const persistableConfig: WorkerConfig = { ...merged };

  // Prefer the environment variable for the auth token so it does not
  // appear in the OS process table (visible via `ps aux` to all local
  // users). The env-var form is set by the coordinator when it spawns
  // the worker. The --token CLI flag is kept as a deprecated fallback
  // for one release cycle.
  const envToken = process.env['AIO_WORKER_TOKEN'];
  if (envToken) {
    merged.authToken = envToken;
  } else if (args['token']) {
    merged.authToken = args['token'];
    persistableConfig.authToken = args['token'];
  }

  // Persist generated values back
  persistConfig(configPath, persistableConfig);

  return merged;
}

function normalizeFileConfig(fileConfig: Partial<WorkerConfig> & PairingConfigFile): Partial<WorkerConfig> {
  const normalized: Partial<WorkerConfig> = { ...fileConfig };

  if (!normalized.authToken && typeof fileConfig.token === 'string') {
    normalized.authToken = fileConfig.token;
  }

  if (typeof fileConfig.host === 'string' && isValidPort(fileConfig.port)) {
    const protocol = fileConfig.requireTls === true ? 'wss' : 'ws';
    normalized.coordinatorUrl = `${protocol}://${fileConfig.host}:${fileConfig.port}`;
  }

  normalized.browserAutomation = normalizeBrowserAutomation(fileConfig.browserAutomation);
  normalized.androidAutomation = normalizeAndroidAutomation(fileConfig.androidAutomation);
  normalized.extensionRelay = normalizeExtensionRelay(fileConfig.extensionRelay);

  return normalized;
}

/**
 * Sanitize the untrusted `browserAutomation` block from disk. Returns undefined
 * (feature off) for anything that isn't an object explicitly enabling it, so a
 * malformed or partial block can never silently turn browser automation on.
 */
function normalizeBrowserAutomation(
  raw: unknown,
): WorkerBrowserAutomationConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['enabled'] !== true) {
    return undefined;
  }
  const result: WorkerBrowserAutomationConfig = { enabled: true };
  if (typeof obj['profileDir'] === 'string' && obj['profileDir'].trim().length > 0) {
    result.profileDir = obj['profileDir'];
  }
  if (typeof obj['headless'] === 'boolean') {
    result.headless = obj['headless'];
  }
  if (typeof obj['chromePath'] === 'string' && obj['chromePath'].trim().length > 0) {
    result.chromePath = obj['chromePath'];
  }
  if (isValidPort(obj['remoteDebuggingPort'])) {
    result.remoteDebuggingPort = obj['remoteDebuggingPort'];
  }
  return result;
}

/**
 * Sanitize the untrusted `androidAutomation` block from disk. Returns undefined
 * (feature off) for anything that is not an object explicitly enabling it.
 * Defaults are applied only after `enabled === true`; malformed optional fields
 * are ignored instead of being persisted into runtime decisions.
 */
function normalizeAndroidAutomation(
  raw: unknown,
): WorkerAndroidAutomationConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['enabled'] !== true) {
    return undefined;
  }

  const result: WorkerAndroidAutomationConfig = {
    enabled: true,
    headlessEmulator: true,
    maxEmulators: 1,
    bootTimeoutMs: 180_000,
    allowPhysicalDevices: true,
    injectMaestroMcp: false,
    appiumMcp: false,
  };

  if (typeof obj['sdkPath'] === 'string' && obj['sdkPath'].trim().length > 0) {
    result.sdkPath = obj['sdkPath'];
  }
  if (typeof obj['defaultAvd'] === 'string' && obj['defaultAvd'].trim().length > 0) {
    result.defaultAvd = obj['defaultAvd'];
  }
  if (typeof obj['headlessEmulator'] === 'boolean') {
    result.headlessEmulator = obj['headlessEmulator'];
  }
  if (isValidMaxEmulators(obj['maxEmulators'])) {
    result.maxEmulators = obj['maxEmulators'];
  }
  if (isValidPositiveInteger(obj['bootTimeoutMs'])) {
    result.bootTimeoutMs = obj['bootTimeoutMs'];
  }
  if (typeof obj['allowPhysicalDevices'] === 'boolean') {
    result.allowPhysicalDevices = obj['allowPhysicalDevices'];
  }
  if (typeof obj['injectMaestroMcp'] === 'boolean') {
    result.injectMaestroMcp = obj['injectMaestroMcp'];
  }
  if (typeof obj['appiumMcp'] === 'boolean') {
    result.appiumMcp = obj['appiumMcp'];
  }
  if (typeof obj['mobileMcpVersion'] === 'string' && obj['mobileMcpVersion'].trim().length > 0) {
    result.mobileMcpVersion = obj['mobileMcpVersion'];
  }
  return result;
}

function normalizeExtensionRelay(
  raw: unknown,
): WorkerExtensionRelayConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const result: WorkerExtensionRelayConfig = {
    enabled: obj['enabled'] === true,
  };
  if (typeof obj['socketPath'] === 'string' && obj['socketPath'].trim().length > 0) {
    result.socketPath = obj['socketPath'];
  }
  if (typeof obj['extensionToken'] === 'string' && obj['extensionToken'].trim().length >= 16) {
    result.extensionToken = obj['extensionToken'];
  }
  return result;
}

export function ensureExtensionRelayDefaults(
  config: WorkerExtensionRelayConfig | undefined,
  defaultSocketPath: () => string,
): WorkerExtensionRelayConfig | undefined {
  if (!config) {
    return undefined;
  }
  if (!config.enabled) {
    return { ...config, enabled: false };
  }
  return {
    ...config,
    enabled: true,
    socketPath: config.socketPath ?? defaultSocketPath(),
    extensionToken: config.extensionToken ?? crypto.randomBytes(32).toString('hex'),
  };
}

/** Default automation profile dir — sibling of the worker config file. */
export function defaultBrowserAutomationProfileDir(): string {
  return path.join(os.homedir(), '.orchestrator', 'browser-automation-profile');
}

export function defaultExtensionRelaySocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\ai-orchestrator-browser-gateway';
  }
  return path.join(os.homedir(), '.orchestrator', 'browser-gateway', 'extension-relay.sock');
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidMaxEmulators(value: unknown): value is number {
  return isValidPositiveInteger(value) && value <= 4;
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      result[key] = argv[++i];
    }
  }
  return result;
}

export function persistConfig(configPath: string, config: WorkerConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function resolveConfigPath(serviceMode: boolean): string {
  if (serviceMode) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { servicePaths } = require('./service/paths') as typeof import('./service/paths');
    return servicePaths().configFile;
  }
  return DEFAULT_CONFIG_PATH;
}
