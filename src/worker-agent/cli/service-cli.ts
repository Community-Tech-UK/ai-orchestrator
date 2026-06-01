import { createServiceManager } from '../service/manager-factory';
import { isElevated, NotElevatedError } from '../service/privilege';
import { resolveToken } from '../service/token-resolver';
import { servicePaths } from '../service/paths';
import { migrateConfigIfNeeded } from '../service/config-migration';
import { activateVersion, listVersions } from '../service/rollback';
import {
  DEFAULT_CONFIG_PATH,
  loadWorkerConfig,
  persistConfig,
  type WorkerConfig,
} from '../worker-config';

export type ServiceCommand =
  | {
      kind: 'install';
      coordinatorUrl: string;
      tokenOpts: TokenCliOpts;
      serviceAccount?: string;
      serviceEnv?: Record<string, string>;
    }
  | { kind: 'uninstall' }
  | { kind: 'status' }
  | { kind: 'run' }
  | { kind: 'list-versions' }
  | { kind: 'activate-version'; version: string };

interface TokenCliOpts {
  tokenFile?: string;
  tokenEnv?: string;
  fromStdin?: boolean;
  interactive?: boolean;
}

export function parseServiceArgs(argv: string[]): ServiceCommand | null {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valuesOf = (flag: string): string[] => {
    const values: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === flag && argv[i + 1]) {
        values.push(argv[i + 1]);
        i++;
      }
    }
    return values;
  };

  if (has('--install-service')) {
    const coordinatorUrl = valueOf('--coordinator-url');
    if (!coordinatorUrl) throw new Error('--install-service requires --coordinator-url');
    return {
      kind: 'install',
      coordinatorUrl,
      tokenOpts: {
        tokenFile: valueOf('--token-file'),
        tokenEnv: valueOf('--token-env'),
        fromStdin: has('--token-stdin'),
        interactive: has('--token-interactive'),
      },
      serviceAccount: valueOf('--service-account'),
      serviceEnv: parseServiceEnv(valuesOf('--service-env')),
    };
  }
  if (has('--uninstall-service')) return { kind: 'uninstall' };
  if (has('--service-status')) return { kind: 'status' };
  if (has('--service-run')) return { kind: 'run' };
  if (has('--list-versions')) return { kind: 'list-versions' };
  if (has('--activate-version')) {
    const version = valueOf('--activate-version');
    if (!version) throw new Error('--activate-version requires a version string');
    return { kind: 'activate-version', version };
  }
  return null;
}

export async function runServiceCommand(cmd: ServiceCommand): Promise<number> {
  const mgr = await createServiceManager();
  const paths = servicePaths();

  switch (cmd.kind) {
    case 'install': {
      if (!(await isElevated())) {
        throw new NotElevatedError('Installing the worker service');
      }
      const { token } = await resolveToken(cmd.tokenOpts);
      await migrateConfigIfNeeded({
        userConfigPath: DEFAULT_CONFIG_PATH,
        serviceConfigPath: paths.configFile,
      });
      const existing = loadWorkerConfig(paths.configFile);
      const merged: WorkerConfig = {
        ...existing,
        coordinatorUrl: cmd.coordinatorUrl,
        authToken: token,
      };
      persistConfig(paths.configFile, merged);
      await mgr.install({
        binaryPath: process.execPath,
        configPath: paths.configFile,
        coordinatorUrl: cmd.coordinatorUrl,
        enrollmentToken: token,
        logDir: paths.logDir,
        serviceAccount: cmd.serviceAccount,
        environment: cmd.serviceEnv,
      });
      process.stdout.write('Service installed and started.\n');
      return 0;
    }
    case 'uninstall':
      if (!(await isElevated())) throw new NotElevatedError('Uninstalling the worker service');
      await mgr.uninstall();
      process.stdout.write('Service uninstalled.\n');
      return 0;
    case 'status': {
      const s = await mgr.status();
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
      return 0;
    }
    case 'run':
      return 0;
    case 'list-versions': {
      const versions = await listVersions();
      process.stdout.write(JSON.stringify(versions, null, 2) + '\n');
      return 0;
    }
    case 'activate-version': {
      if (!(await isElevated())) {
        throw new NotElevatedError('Activating a worker service version');
      }
      await activateVersion(cmd.version);
      await mgr.restart();
      process.stdout.write(`Activated version ${cmd.version} and restarted service.\n`);
      return 0;
    }
  }
}

function parseServiceEnv(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--service-env must be KEY=VALUE, got "${entry}"`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --service-env key "${key}"`);
    }
    env[key] = value;
  }
  return env;
}
