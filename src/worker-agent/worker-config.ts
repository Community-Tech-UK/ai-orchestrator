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

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.orchestrator', 'worker-node.json');

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
    fileConfig = JSON.parse(raw) as Partial<WorkerConfig>;
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
  if (args['token']) merged.authToken = args['token'];
  if (args['namespace']) merged.namespace = args['namespace'];

  // Persist generated values back
  persistConfig(configPath, merged);

  return merged;
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
