import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWindowsNativeMessagingRegistry,
  type WindowsNativeMessagingRegistry,
} from './windows-native-messaging-registry';

export const BROWSER_EXTENSION_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway';
export const BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway_relay';
export const BROWSER_EXTENSION_ID = 'jbkobgefdoglecnehdhfpgjamiginjfo';
export const BROWSER_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo+StOfam7CfQRsUs+A72AlgFLUnfSQXxJefJ1HHVEl5bxwoN4RA+TkUwflMu6BUHp0ZdtYg/g02sn8SB0og2RDLPKYoVfKGFXl07TOPjidiA/F2MxZe3Ck9icG7oSCIl8eff2BaMSUsuZ3YB+Wo712uVS2Rg0gcq5YIpiBWMpYRARG9w0gN+Hvdug7QsSGYfwZ0upyJAZj/wottlOeSD5u0uKfpXCo4esfyZeKAtIOXpNkNE04Fd821WZjOHZj1f9wdHqXFtESrffFEO6x6IMz3/gwnLNm0NDBX3jBh27+v+OapdPVAAmK9ROtTAGkXlH41PCCuntrtcktpimbYuhwIDAQAB';

export interface BrowserExtensionNativeRuntimeConfig {
  socketPath: string;
  extensionToken: string;
  updatedAt: number;
}

export interface BrowserExtensionNativeHostCommand {
  exe: string;
  args?: string[];
}

export interface BrowserExtensionNativeRuntimeOptions {
  userDataPath: string;
  socketPath: string;
  extensionToken: string;
  hostCommand: BrowserExtensionNativeHostCommand;
  hostName?: string;
  chromeNativeMessagingDir?: string;
  registerInOS?: boolean;
  windowsRegistry?: WindowsNativeMessagingRegistry;
  now?: () => number;
}

export interface BrowserExtensionNativeRuntimeInstallResult {
  nativeDir: string;
  runtimeConfigPath: string;
  wrapperPath: string;
  manifestPath: string;
}

export interface BrowserExtensionNativeRuntimeRemoveResult {
  nativeDir: string;
  manifestPath: string;
}

export function prepareBrowserExtensionNativeHostRuntime(
  options: BrowserExtensionNativeRuntimeOptions,
): BrowserExtensionNativeRuntimeInstallResult {
  const hostName = options.hostName ?? BROWSER_EXTENSION_NATIVE_HOST_NAME;
  const paths = browserExtensionNativeHostPaths({
    userDataPath: options.userDataPath,
    chromeNativeMessagingDir: options.chromeNativeMessagingDir,
    hostName,
  });
  const { nativeDir, runtimeConfigPath, wrapperPath, manifestPath } = paths;
  fs.mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
  chmodIfSupported(nativeDir, 0o700);

  const runtimeConfig: BrowserExtensionNativeRuntimeConfig = {
    socketPath: options.socketPath,
    extensionToken: options.extensionToken,
    updatedAt: options.now?.() ?? Date.now(),
  };
  fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodIfSupported(runtimeConfigPath, 0o600);

  writeNativeHostWrapper({
    wrapperPath,
    runtimeConfigPath,
    hostCommand: options.hostCommand,
  });

  const chromeNativeMessagingDirWasDefaulted = options.chromeNativeMessagingDir === undefined;
  fs.mkdirSync(paths.chromeNativeMessagingDir, { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      name: hostName,
      description: 'Harness Browser Gateway native host',
      path: wrapperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    }, null, 2)}\n`,
  );
  if (options.registerInOS ?? chromeNativeMessagingDirWasDefaulted) {
    assertWindowsRegistrationPathIsSafe(manifestPath);
    const registered = (options.windowsRegistry ?? createWindowsNativeMessagingRegistry())
      .registerHost(hostName, manifestPath);
    if (!registered) {
      throw new Error(`windows_native_messaging_registration_failed:${hostName}`);
    }
  }

  return {
    nativeDir,
    runtimeConfigPath,
    wrapperPath,
    manifestPath,
  };
}

export function removeBrowserExtensionNativeHostRuntime(options: {
  userDataPath: string;
  hostName?: string;
  chromeNativeMessagingDir?: string;
  registerInOS?: boolean;
  windowsRegistry?: WindowsNativeMessagingRegistry;
}): BrowserExtensionNativeRuntimeRemoveResult {
  const hostName = options.hostName ?? BROWSER_EXTENSION_NATIVE_HOST_NAME;
  const paths = browserExtensionNativeHostPaths({
    userDataPath: options.userDataPath,
    chromeNativeMessagingDir: options.chromeNativeMessagingDir,
    hostName,
  });
  const { nativeDir, manifestPath } = paths;
  const chromeNativeMessagingDirWasDefaulted = options.chromeNativeMessagingDir === undefined;
  try {
    fs.rmSync(paths.runtimeConfigPath, { force: true });
    fs.rmSync(paths.wrapperPath, { force: true });
  } catch {
    // Best-effort cleanup; stale files are harmless once the manifest is gone.
  }
  try {
    fs.unlinkSync(manifestPath);
  } catch {
    // Already removed.
  }
  if (options.registerInOS ?? chromeNativeMessagingDirWasDefaulted) {
    assertWindowsRegistrationPathIsSafe(manifestPath);
    (options.windowsRegistry ?? createWindowsNativeMessagingRegistry())
      .unregisterHost(hostName);
  }
  return { nativeDir, manifestPath };
}

export interface BrowserExtensionNativeHostPaths {
  nativeDir: string;
  chromeNativeMessagingDir: string;
  runtimeConfigPath: string;
  wrapperPath: string;
  manifestPath: string;
}

export function browserExtensionNativeHostPaths(options: {
  userDataPath: string;
  chromeNativeMessagingDir?: string;
  hostName?: string;
}): BrowserExtensionNativeHostPaths {
  const hostName = options.hostName ?? BROWSER_EXTENSION_NATIVE_HOST_NAME;
  const nativeDir = path.join(options.userDataPath, 'browser-gateway', 'native-host');
  const chromeNativeMessagingDir =
    options.chromeNativeMessagingDir ?? defaultChromeNativeMessagingDir();
  const suffix = browserExtensionNativeHostFileSuffix(hostName);
  const wrapperBaseName = suffix
    ? `ai-orchestrator-browser-host-${suffix}`
    : 'ai-orchestrator-browser-host';
  const wrapperFileName = process.platform === 'win32'
    ? `${wrapperBaseName}.cmd`
    : wrapperBaseName;
  return {
    nativeDir,
    chromeNativeMessagingDir,
    runtimeConfigPath: path.join(nativeDir, suffix ? `runtime-${suffix}.json` : 'runtime.json'),
    wrapperPath: path.join(nativeDir, wrapperFileName),
    manifestPath: browserExtensionNativeHostManifestPath(chromeNativeMessagingDir, hostName),
  };
}

export function browserExtensionNativeHostManifestPath(
  chromeNativeMessagingDir = defaultChromeNativeMessagingDir(),
  hostName = BROWSER_EXTENSION_NATIVE_HOST_NAME,
): string {
  return path.join(chromeNativeMessagingDir, `${hostName}.json`);
}

export function assertBrowserExtensionNativeHostManifestWritable(input: {
  manifestPath: string;
  nativeDir: string;
  force: boolean;
}): void {
  if (input.force || !fs.existsSync(input.manifestPath)) {
    return;
  }
  if (isBrowserExtensionNativeHostManifestOwned(input)) {
    return;
  }
  throw new Error(
    `Refusing to overwrite existing Chrome native host manifest at ${input.manifestPath}; use --force if this machine should use the worker extension relay.`,
  );
}

export function isBrowserExtensionNativeHostManifestOwned(input: {
  manifestPath: string;
  nativeDir: string;
}): boolean {
  if (!fs.existsSync(input.manifestPath)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(input.manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as { path?: unknown };
    const existingPath = typeof manifest.path === 'string' ? manifest.path : '';
    return existingPath.length > 0 && isPathInsideOrSame(input.nativeDir, existingPath);
  } catch {
    return false;
  }
}

function assertWindowsRegistrationPathIsSafe(manifestPath: string): void {
  if (process.platform !== 'win32') {
    return;
  }
  if (!isPathInsideOrSame(os.tmpdir(), manifestPath)) {
    return;
  }
  throw new Error(
    `Refusing to touch Windows native host registration under temp directory: ${manifestPath}`,
  );
}

function writeNativeHostWrapper(options: {
  wrapperPath: string;
  runtimeConfigPath: string;
  hostCommand: BrowserExtensionNativeHostCommand;
}): void {
  const commandArgs = options.hostCommand.args ?? [];
  if (process.platform === 'win32') {
    fs.writeFileSync(
      options.wrapperPath,
      [
        '@echo off',
        `set AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${options.runtimeConfigPath}`,
        [
          quoteCmd(options.hostCommand.exe),
          ...commandArgs.map(quoteCmd),
          '%*',
        ].join(' '),
        '',
      ].join('\r\n'),
    );
    return;
  }

  fs.writeFileSync(
    options.wrapperPath,
    [
      '#!/bin/sh',
      `AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${quoteSh(options.runtimeConfigPath)} \\`,
      [
        'exec',
        quoteSh(options.hostCommand.exe),
        ...commandArgs.map(quoteSh),
        '"$@"',
      ].join(' '),
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodIfSupported(options.wrapperPath, 0o700);
}

function defaultChromeNativeMessagingDir(): string {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
    );
  }
  if (process.platform === 'win32') {
    return path.join(
      os.homedir(),
      'AppData',
      'Local',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
    );
  }
  return path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
}

function chmodIfSupported(targetPath: string, mode: number): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.chmodSync(targetPath, mode);
}

function browserExtensionNativeHostFileSuffix(hostName: string): string {
  if (hostName === BROWSER_EXTENSION_NATIVE_HOST_NAME) {
    return '';
  }
  const prefix = `${BROWSER_EXTENSION_NATIVE_HOST_NAME}_`;
  const rawSuffix = hostName.startsWith(prefix)
    ? hostName.slice(prefix.length)
    : hostName;
  const suffix = rawSuffix
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return suffix || 'custom';
}

function isPathInsideOrSame(parent: string, child: string): boolean {
  const relative = path.relative(resolveNativePath(parent), resolveNativePath(child));
  return (
    relative === ''
    || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function resolveNativePath(targetPath: string): string {
  const resolvedPath = path.resolve(targetPath);
  const missingSegments: string[] = [];
  let candidate = resolvedPath;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(candidate), ...missingSegments.reverse());
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return resolvedPath;
      }
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
