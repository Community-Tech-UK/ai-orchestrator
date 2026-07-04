import { createServiceManager } from '../service/manager-factory';
import { isElevated, NotElevatedError } from '../service/privilege';
import { resolveToken } from '../service/token-resolver';
import { servicePaths } from '../service/paths';
import { migrateConfigIfNeeded } from '../service/config-migration';
import { activateVersion, listVersions } from '../service/rollback';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG_PATH,
  defaultExtensionRelaySocketPath,
  ensureExtensionRelayDefaults,
  loadWorkerConfig,
  normalizeCoordinatorUrl,
  persistConfig,
  type WorkerConfig,
} from '../worker-config';
import {
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
  assertBrowserExtensionNativeHostManifestWritable,
  browserExtensionNativeHostPaths,
  browserExtensionNativeHostManifestPath,
  isBrowserExtensionNativeHostManifestOwned,
  prepareBrowserExtensionNativeHostRuntime,
  removeBrowserExtensionNativeHostRuntime,
} from '../../main/browser-gateway/browser-extension-native-runtime';

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
  | { kind: 'install-extension-relay'; configPath?: string; force?: boolean }
  | { kind: 'uninstall-extension-relay'; configPath?: string }
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

  if (argv[0] === 'install-browser-extension' || argv[0] === 'install-extension-relay') {
    return {
      kind: 'install-extension-relay',
      configPath: valueOf('--config'),
      ...(has('--force') ? { force: true } : {}),
    };
  }
  if (argv[0] === 'uninstall-browser-extension' || argv[0] === 'uninstall-extension-relay') {
    return { kind: 'uninstall-extension-relay', configPath: valueOf('--config') };
  }
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
  if (has('--install-extension-relay')) {
    return {
      kind: 'install-extension-relay',
      configPath: valueOf('--config'),
      ...(has('--force') ? { force: true } : {}),
    };
  }
  if (has('--uninstall-extension-relay')) {
    return { kind: 'uninstall-extension-relay', configPath: valueOf('--config') };
  }
  if (has('--list-versions')) return { kind: 'list-versions' };
  if (has('--activate-version')) {
    const version = valueOf('--activate-version');
    if (!version) throw new Error('--activate-version requires a version string');
    return { kind: 'activate-version', version };
  }
  return null;
}

export async function runServiceCommand(cmd: ServiceCommand): Promise<number> {
  const paths = servicePaths();

  switch (cmd.kind) {
    case 'install': {
      const mgr = await createServiceManager();
      if (!(await isElevated())) {
        throw new NotElevatedError('Installing the worker service');
      }
      const { token } = await resolveToken(cmd.tokenOpts);
      await migrateConfigIfNeeded({
        userConfigPath: DEFAULT_CONFIG_PATH,
        serviceConfigPath: paths.configFile,
      });
      const existing = loadWorkerConfig(paths.configFile);
      const coordinatorUrl = normalizeCoordinatorUrl(cmd.coordinatorUrl) ?? cmd.coordinatorUrl;
      const merged: WorkerConfig = {
        ...existing,
        coordinatorUrl,
        authToken: token,
      };
      delete merged.nodeToken;
      delete merged.recoveryToken;
      persistConfig(paths.configFile, merged);
      await mgr.install({
        binaryPath: process.execPath,
        configPath: paths.configFile,
        coordinatorUrl,
        enrollmentToken: token,
        logDir: paths.logDir,
        serviceAccount: cmd.serviceAccount,
        environment: cmd.serviceEnv,
      });
      process.stdout.write('Service installed and started.\n');
      return 0;
    }
    case 'uninstall':
    {
      const mgr = await createServiceManager();
      if (!(await isElevated())) throw new NotElevatedError('Uninstalling the worker service');
      await mgr.uninstall();
      process.stdout.write('Service uninstalled.\n');
      return 0;
    }
    case 'status': {
      const mgr = await createServiceManager();
      const s = await mgr.status();
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
      return 0;
    }
    case 'run':
      return 0;
    case 'install-extension-relay': {
      const configPath = cmd.configPath ?? DEFAULT_CONFIG_PATH;
      const config = loadWorkerConfig(configPath);
      const extensionRelay = ensureExtensionRelayDefaults(
        {
          ...config.extensionRelay,
          enabled: true,
        },
        defaultExtensionRelaySocketPath,
      );
      if (!extensionRelay?.extensionToken || !extensionRelay.socketPath) {
        throw new Error('Failed to prepare extension relay config');
      }
      const userDataPath = path.dirname(configPath);
      if (extensionRelay.legacyNameRegistration !== false) {
        assertBrowserExtensionNativeHostManifestWritable({
          manifestPath: browserExtensionNativeHostManifestPath(undefined, BROWSER_EXTENSION_NATIVE_HOST_NAME),
          nativeDir: browserExtensionNativeHostPaths({
            userDataPath,
            hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
          }).nativeDir,
          force: cmd.force === true,
        });
      }
      config.extensionRelay = extensionRelay;
      persistConfig(configPath, config);
      const result = prepareBrowserExtensionNativeHostRuntime({
        userDataPath,
        socketPath: extensionRelay.socketPath,
        extensionToken: extensionRelay.extensionToken,
        hostCommand: currentWorkerNativeHostCommand(),
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      });
      if (extensionRelay.legacyNameRegistration !== false) {
        prepareBrowserExtensionNativeHostRuntime({
          userDataPath,
          socketPath: extensionRelay.socketPath,
          extensionToken: extensionRelay.extensionToken,
          hostCommand: currentWorkerNativeHostCommand(),
          hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
        });
      }
      process.stdout.write(
        [
          `Browser extension relay native host installed: ${result.manifestPath}`,
          'Load the unpacked Chrome extension from resources/browser-extension on the remote machine.',
          'If this worker is on another host, copy that directory there before loading it in Chrome.',
          '',
        ].join('\n'),
      );
      return 0;
    }
    case 'uninstall-extension-relay': {
      const configPath = cmd.configPath ?? DEFAULT_CONFIG_PATH;
      const config = loadWorkerConfig(configPath);
      config.extensionRelay = {
        ...config.extensionRelay,
        enabled: false,
      };
      persistConfig(configPath, config);
      const result = removeBrowserExtensionNativeHostRuntime({
        userDataPath: path.dirname(configPath),
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      });
      removeLegacyExtensionRelayNativeHostIfOwned(path.dirname(configPath));
      process.stdout.write(`Browser extension relay native host removed: ${result.manifestPath}\n`);
      return 0;
    }
    case 'list-versions': {
      const versions = await listVersions();
      process.stdout.write(JSON.stringify(versions, null, 2) + '\n');
      return 0;
    }
    case 'activate-version': {
      const mgr = await createServiceManager();
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

function removeLegacyExtensionRelayNativeHostIfOwned(userDataPath: string): void {
  const nativeDir = browserExtensionNativeHostPaths({
    userDataPath,
    hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
  }).nativeDir;
  const manifestPath = browserExtensionNativeHostManifestPath(
    undefined,
    BROWSER_EXTENSION_NATIVE_HOST_NAME,
  );
  if (!isBrowserExtensionNativeHostManifestOwned({ manifestPath, nativeDir })) {
    return;
  }
  removeBrowserExtensionNativeHostRuntime({
    userDataPath,
    hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
  });
}

function currentWorkerNativeHostCommand(): { exe: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint && path.resolve(entrypoint) !== path.resolve(process.execPath)) {
    return {
      exe: process.execPath,
      args: [entrypoint, 'native-host'],
    };
  }
  return {
    exe: process.execPath,
    args: ['native-host'],
  };
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
