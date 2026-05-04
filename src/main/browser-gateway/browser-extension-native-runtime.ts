import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BROWSER_EXTENSION_NATIVE_HOST_NAME = 'com.ai_orchestrator.browser_gateway';
export const BROWSER_EXTENSION_ID = 'jbkobgefdoglecnehdhfpgjamiginjfo';
export const BROWSER_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAo+StOfam7CfQRsUs+A72AlgFLUnfSQXxJefJ1HHVEl5bxwoN4RA+TkUwflMu6BUHp0ZdtYg/g02sn8SB0og2RDLPKYoVfKGFXl07TOPjidiA/F2MxZe3Ck9icG7oSCIl8eff2BaMSUsuZ3YB+Wo712uVS2Rg0gcq5YIpiBWMpYRARG9w0gN+Hvdug7QsSGYfwZ0upyJAZj/wottlOeSD5u0uKfpXCo4esfyZeKAtIOXpNkNE04Fd821WZjOHZj1f9wdHqXFtESrffFEO6x6IMz3/gwnLNm0NDBX3jBh27+v+OapdPVAAmK9ROtTAGkXlH41PCCuntrtcktpimbYuhwIDAQAB';

export interface BrowserExtensionNativeRuntimeConfig {
  socketPath: string;
  extensionToken: string;
  updatedAt: number;
}

export interface BrowserExtensionNativeRuntimeOptions {
  userDataPath: string;
  socketPath: string;
  extensionToken: string;
  electronPath: string;
  nativeHostScriptPath: string;
  chromeNativeMessagingDir?: string;
  now?: () => number;
}

export interface BrowserExtensionNativeRuntimeInstallResult {
  runtimeConfigPath: string;
  wrapperPath: string;
  manifestPath: string;
}

export function prepareBrowserExtensionNativeHostRuntime(
  options: BrowserExtensionNativeRuntimeOptions,
): BrowserExtensionNativeRuntimeInstallResult {
  const nativeDir = path.join(options.userDataPath, 'browser-gateway', 'native-host');
  fs.mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
  chmodIfSupported(nativeDir, 0o700);

  const runtimeConfigPath = path.join(nativeDir, 'runtime.json');
  const runtimeConfig: BrowserExtensionNativeRuntimeConfig = {
    socketPath: options.socketPath,
    extensionToken: options.extensionToken,
    updatedAt: options.now?.() ?? Date.now(),
  };
  fs.writeFileSync(runtimeConfigPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodIfSupported(runtimeConfigPath, 0o600);

  const wrapperPath = path.join(
    nativeDir,
    process.platform === 'win32' ? 'ai-orchestrator-browser-host.cmd' : 'ai-orchestrator-browser-host',
  );
  writeNativeHostWrapper({
    wrapperPath,
    runtimeConfigPath,
    electronPath: options.electronPath,
    nativeHostScriptPath: options.nativeHostScriptPath,
  });

  const chromeNativeMessagingDir =
    options.chromeNativeMessagingDir ?? defaultChromeNativeMessagingDir();
  fs.mkdirSync(chromeNativeMessagingDir, { recursive: true });
  const manifestPath = path.join(
    chromeNativeMessagingDir,
    `${BROWSER_EXTENSION_NATIVE_HOST_NAME}.json`,
  );
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
      description: 'AI Orchestrator Browser Gateway native host',
      path: wrapperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    }, null, 2)}\n`,
  );
  registerWindowsNativeMessagingHost(manifestPath);

  return {
    runtimeConfigPath,
    wrapperPath,
    manifestPath,
  };
}

function registerWindowsNativeMessagingHost(manifestPath: string): void {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    execFileSync('reg', [
      'ADD',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_EXTENSION_NATIVE_HOST_NAME}`,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f',
    ], { stdio: 'ignore' });
  } catch {
    // Health/UI can surface setup gaps; runtime startup should not fail on registry writes.
  }
}

function writeNativeHostWrapper(options: {
  wrapperPath: string;
  runtimeConfigPath: string;
  electronPath: string;
  nativeHostScriptPath: string;
}): void {
  if (process.platform === 'win32') {
    fs.writeFileSync(
      options.wrapperPath,
      [
        '@echo off',
        `set AI_ORCHESTRATOR_BROWSER_NATIVE_CONFIG=${options.runtimeConfigPath}`,
        'set ELECTRON_RUN_AS_NODE=1',
        `"${options.electronPath}" "${options.nativeHostScriptPath}" %*`,
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
      'ELECTRON_RUN_AS_NODE=1 \\',
      `exec ${quoteSh(options.electronPath)} ${quoteSh(options.nativeHostScriptPath)} "$@"`,
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

function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
