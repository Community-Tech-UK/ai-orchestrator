import { createServiceManager } from '../service/manager-factory';
import { isElevated, NotElevatedError } from '../service/privilege';
import { resolveToken } from '../service/token-resolver';
import { servicePaths } from '../service/paths';
import { migrateConfigIfNeeded } from '../service/config-migration';
import {
  DEFAULT_CONFIG_PATH,
  loadWorkerConfig,
  persistConfig,
  type WorkerConfig,
} from '../worker-config';

export type ServiceCommand =
  | { kind: 'install'; coordinatorUrl: string; tokenOpts: TokenCliOpts }
  | { kind: 'uninstall' }
  | { kind: 'status' }
  | { kind: 'run' };

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
    };
  }
  if (has('--uninstall-service')) return { kind: 'uninstall' };
  if (has('--service-status')) return { kind: 'status' };
  if (has('--service-run')) return { kind: 'run' };
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
  }
}

