import * as fs from 'node:fs';
import {
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
  assertBrowserExtensionNativeHostManifestWritable,
  browserExtensionNativeHostManifestPath,
  browserExtensionNativeHostPaths,
  isBrowserExtensionNativeHostManifestOwned,
  prepareBrowserExtensionNativeHostRuntime,
  type BrowserExtensionNativeRuntimeConfig,
  type BrowserExtensionNativeHostCommand,
} from '../main/browser-gateway/browser-extension-native-runtime';
import {
  createWindowsNativeMessagingRegistry,
  type WindowsNativeMessagingRegistry,
} from '../main/browser-gateway/windows-native-messaging-registry';
import type { WorkerExtensionRelayConfig } from './worker-config';
import type { WorkerNodeExtensionRelaySummary } from '../shared/types/worker-node.types';

const REPAIR_FLAP_WINDOW_MS = 10 * 60_000;
const CONTESTED_REPAIR_THRESHOLD = 3;

type RegistrationSummary = Pick<
  WorkerNodeExtensionRelaySummary,
  'registration' | 'lastRegistrationCheckAt' | 'manifestPath' | 'registrationError'
>;

export interface ExtensionRelayNativeRegistrationOptions {
  userDataPath: string;
  hostCommand: BrowserExtensionNativeHostCommand;
  chromeNativeMessagingDir?: string;
  registry?: WindowsNativeMessagingRegistry;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

export interface LegacyExtensionRelayNativeHostOptions {
  userDataPath: string;
  socketPath: string;
  extensionToken: string;
  hostCommand: BrowserExtensionNativeHostCommand;
  logger?: Pick<Console, 'warn'>;
}

export class ExtensionRelayNativeRegistration {
  private readonly userDataPath: string;
  private readonly hostCommand: BrowserExtensionNativeHostCommand;
  private readonly chromeNativeMessagingDir?: string;
  private readonly registry: WindowsNativeMessagingRegistry;
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private repairTimestamps: number[] = [];
  private warnedContested = false;
  private lastSummary: RegistrationSummary | undefined;

  constructor(options: ExtensionRelayNativeRegistrationOptions) {
    this.userDataPath = options.userDataPath;
    this.hostCommand = options.hostCommand;
    this.chromeNativeMessagingDir = options.chromeNativeMessagingDir;
    this.registry = options.registry ?? createWindowsNativeMessagingRegistry();
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
  }

  getLastSummary(): RegistrationSummary | undefined {
    return this.lastSummary;
  }

  checkAndRepair(config: WorkerExtensionRelayConfig): RegistrationSummary {
    const checkedAt = this.now();
    const paths = browserExtensionNativeHostPaths({
      userDataPath: this.userDataPath,
      chromeNativeMessagingDir: this.chromeNativeMessagingDir,
      hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    });
    const base = {
      lastRegistrationCheckAt: checkedAt,
      manifestPath: paths.manifestPath,
    };

    if (!config.enabled || !config.socketPath || !config.extensionToken) {
      this.lastSummary = {
        ...base,
        registration: 'error',
        registrationError: 'extension_relay_not_configured',
      };
      return this.lastSummary;
    }

    try {
      const registeredManifestPath = this.readRegisteredManifestPath();
      const validationError = this.validate(paths, config, registeredManifestPath);
      if (!validationError) {
        this.lastSummary = { ...base, registration: 'ok' };
        return this.lastSummary;
      }
      if (this.foreignManifestOwnerPath(paths)) {
        this.warnContested(paths.manifestPath);
        this.lastSummary = {
          ...base,
          registration: 'contested',
          registrationError: 'foreign_relay_manifest',
        };
        return this.lastSummary;
      }

      prepareBrowserExtensionNativeHostRuntime({
        userDataPath: this.userDataPath,
        socketPath: config.socketPath,
        extensionToken: config.extensionToken,
        hostCommand: this.hostCommand,
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
        chromeNativeMessagingDir: this.chromeNativeMessagingDir,
        windowsRegistry: this.registry,
        registerInOS: true,
      });

      const registration = this.recordRepair(checkedAt);
      if (registration === 'contested') {
        this.warnContested(paths.manifestPath);
      } else {
        this.logger.info('[WorkerExtensionRelay] Repaired native-host registration', {
          hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
          reason: validationError,
          manifestPath: paths.manifestPath,
        });
      }
      this.lastSummary = { ...base, registration };
      return this.lastSummary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('[WorkerExtensionRelay] Native-host registration check failed', {
        hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
        error: message,
      });
      this.lastSummary = {
        ...base,
        registration: 'error',
        registrationError: message,
      };
      return this.lastSummary;
    }
  }

  private validate(paths: {
    runtimeConfigPath: string;
    wrapperPath: string;
    manifestPath: string;
    nativeDir: string;
  }, config: WorkerExtensionRelayConfig, registeredManifestPath: string | undefined): string | undefined {
    if (
      process.platform === 'win32'
      && registeredManifestPath !== paths.manifestPath
    ) {
      return 'registry_mismatch';
    }
    if (!fs.existsSync(paths.manifestPath)) {
      return 'manifest_missing';
    }
    let manifest: { name?: unknown; path?: unknown };
    try {
      manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf-8')) as {
        name?: unknown;
        path?: unknown;
      };
    } catch {
      return 'manifest_invalid';
    }
    if (manifest.name !== BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME) {
      return 'manifest_name_mismatch';
    }
    if (manifest.path !== paths.wrapperPath) {
      return 'manifest_path_mismatch';
    }
    if (!fs.existsSync(paths.runtimeConfigPath)) {
      return 'runtime_config_missing';
    }
    const runtimeConfigError = this.validateRuntimeConfig(paths.runtimeConfigPath, config);
    if (runtimeConfigError) {
      return runtimeConfigError;
    }
    if (!fs.existsSync(paths.wrapperPath)) {
      return 'wrapper_missing';
    }
    return undefined;
  }

  private validateRuntimeConfig(
    runtimeConfigPath: string,
    config: WorkerExtensionRelayConfig,
  ): string | undefined {
    let runtimeConfig: BrowserExtensionNativeRuntimeConfig;
    try {
      runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8')) as BrowserExtensionNativeRuntimeConfig;
    } catch {
      return 'runtime_config_invalid';
    }
    if (
      runtimeConfig.socketPath !== config.socketPath
      || runtimeConfig.extensionToken !== config.extensionToken
    ) {
      return 'runtime_config_mismatch';
    }
    return undefined;
  }

  private readRegisteredManifestPath(): string | undefined {
    if (process.platform !== 'win32') {
      return undefined;
    }
    return this.registry.readManifestPath(BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME);
  }

  private foreignManifestOwnerPath(paths: {
    manifestPath: string;
    nativeDir: string;
  }): string | undefined {
    if (!fs.existsSync(paths.manifestPath)) {
      return undefined;
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(paths.manifestPath, 'utf-8')) as { path?: unknown };
      const ownerPath = typeof manifest.path === 'string' && manifest.path ? manifest.path : undefined;
      if (
        ownerPath
        && !isBrowserExtensionNativeHostManifestOwned({
          manifestPath: paths.manifestPath,
          nativeDir: paths.nativeDir,
        })
      ) {
        return ownerPath;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private recordRepair(now: number): 'repaired' | 'contested' {
    this.repairTimestamps = this.repairTimestamps
      .filter((timestamp) => now - timestamp <= REPAIR_FLAP_WINDOW_MS);
    this.repairTimestamps.push(now);
    return this.repairTimestamps.length > CONTESTED_REPAIR_THRESHOLD
      ? 'contested'
      : 'repaired';
  }

  private warnContested(manifestPath: string): void {
    if (this.warnedContested) {
      return;
    }
    this.warnedContested = true;
    this.logger.warn('[WorkerExtensionRelay] Native-host registration contested', {
      hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      manifestPath,
      repairs: this.repairTimestamps.length,
      windowMs: REPAIR_FLAP_WINDOW_MS,
    });
  }
}

export function prepareLegacyExtensionRelayNativeHostRuntime(
  options: LegacyExtensionRelayNativeHostOptions,
): void {
  const logger = options.logger ?? console;
  try {
    const nativeDir = browserExtensionNativeHostPaths({
      userDataPath: options.userDataPath,
      hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
    }).nativeDir;
    assertBrowserExtensionNativeHostManifestWritable({
      manifestPath: browserExtensionNativeHostManifestPath(undefined, BROWSER_EXTENSION_NATIVE_HOST_NAME),
      nativeDir,
      force: false,
    });
    prepareBrowserExtensionNativeHostRuntime({
      userDataPath: options.userDataPath,
      socketPath: options.socketPath,
      extensionToken: options.extensionToken,
      hostCommand: options.hostCommand,
      hostName: BROWSER_EXTENSION_NATIVE_HOST_NAME,
    });
  } catch (error) {
    logger.warn(
      '[WorkerExtensionRelay] Failed to install transitional legacy browser extension native host runtime',
      error instanceof Error ? error.message : String(error),
    );
  }
}
