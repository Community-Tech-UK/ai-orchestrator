import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface WorkerConfig {
  nodeId: string;
  name: string;
  coordinatorUrl?: string;
  authToken: string;
  nodeToken?: string;
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  reconnectIntervalMs: number;
  heartbeatIntervalMs: number;
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

  // Apply CLI overrides
  const args = parseCliArgs(process.argv.slice(2));
  if (args['coordinator']) merged.coordinatorUrl = args['coordinator'];
  if (args['name']) merged.name = args['name'];
  if (args['namespace']) merged.namespace = args['namespace'];

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
  }

  // Persist generated values back
  persistConfig(configPath, merged);

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

  return normalized;
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
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
