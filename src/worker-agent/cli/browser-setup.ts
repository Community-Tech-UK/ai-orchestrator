import * as path from 'node:path';
import {
  defaultExtensionRelaySocketPath,
  ensureExtensionRelayDefaults,
  loadWorkerConfig,
  persistConfig,
} from '../worker-config';
import {
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
  assertBrowserExtensionNativeHostManifestWritable,
  browserExtensionNativeHostPaths,
  browserExtensionNativeHostManifestPath,
  prepareBrowserExtensionNativeHostRuntime,
} from '../../main/browser-gateway/browser-extension-native-runtime';
import { resolveChromeExecutablePath } from '../capability-reporter';
import { workerBrowserExtensionFolder } from '../browser-extension-folder';

/**
 * Turn on the extension relay in the config and register the Chrome native
 * host for it. Throws when the legacy host name belongs to another program
 * and `force` was not given.
 */
export function installExtensionRelay(configPath: string, force: boolean): { manifestPath: string } {
  const config = loadWorkerConfig(configPath);
  const extensionRelay = ensureExtensionRelayDefaults(
    { ...config.extensionRelay, enabled: true },
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
      force,
    });
  }
  config.extensionRelay = extensionRelay;
  persistConfig(configPath, config);
  const hostNames = extensionRelay.legacyNameRegistration !== false
    ? [BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME, BROWSER_EXTENSION_NATIVE_HOST_NAME]
    : [BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME];
  const [result] = hostNames.map((hostName) => prepareBrowserExtensionNativeHostRuntime({
    userDataPath,
    socketPath: extensionRelay.socketPath as string,
    extensionToken: extensionRelay.extensionToken as string,
    hostCommand: currentWorkerNativeHostCommand(),
    hostName,
  }));
  return { manifestPath: result.manifestPath };
}

/** How to load the unpacked extension on this computer. */
export function loadExtensionInstruction(): string {
  const folder = workerBrowserExtensionFolder();
  return folder
    ? `Load the Chrome extension on this computer: chrome://extensions, turn on Developer mode, Load unpacked, choose ${folder}`
    : 'Load the Chrome extension on this computer from the resources/browser-extension folder of a Harness checkout (chrome://extensions, Developer mode, Load unpacked).';
}

export interface BrowserSetupDeps {
  resolveChromePath?: () => string | null;
  installRelay?: (configPath: string) => { manifestPath: string };
}

/**
 * At pairing and install: when Chrome is installed, turn on browser automation
 * (a visible Chrome with Harness's own profile) and the extension relay, and
 * register the native host, so a new computer offers browser work without
 * anyone editing `worker-node.json`. Returns the lines to print. `--no-browser`
 * callers skip this.
 */
export function setUpBrowserFeatures(configPath: string, deps: BrowserSetupDeps = {}): string[] {
  const chromePath = (deps.resolveChromePath ?? resolveChromeExecutablePath)();
  if (!chromePath) {
    return ['Chrome is not installed here, so browser features stay off.'];
  }
  const config = loadWorkerConfig(configPath);
  config.browserAutomation = { ...config.browserAutomation, enabled: true, headless: false };
  persistConfig(configPath, config);

  const lines = ['Browser features turned on (Chrome found). Use --no-browser to leave them off.'];
  try {
    (deps.installRelay ?? ((p) => installExtensionRelay(p, false)))(configPath);
  } catch (error) {
    lines.push(
      `The Chrome extension link was not set up: ${error instanceof Error ? error.message : String(error)}`,
      'Run aio-worker install-browser-extension --force to set it up.',
    );
    return lines;
  }
  lines.push(loadExtensionInstruction());
  return lines;
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
