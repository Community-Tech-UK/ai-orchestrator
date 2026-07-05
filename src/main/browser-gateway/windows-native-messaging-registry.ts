import { execFileSync as defaultExecFileSync } from 'node:child_process';

const CHROME_NATIVE_MESSAGING_REGISTRY_ROOT =
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';

export interface WindowsNativeMessagingRegistry {
  readManifestPath(hostName: string): string | undefined;
  registerHost(hostName: string, manifestPath: string): boolean;
  unregisterHost(hostName: string): boolean;
}

export interface WindowsNativeMessagingRegistryOptions {
  execFileSync?: typeof defaultExecFileSync;
}

export function createWindowsNativeMessagingRegistry(
  options: WindowsNativeMessagingRegistryOptions = {},
): WindowsNativeMessagingRegistry {
  const execFileSync = options.execFileSync ?? defaultExecFileSync;
  return {
    readManifestPath(hostName: string): string | undefined {
      if (process.platform !== 'win32') {
        return undefined;
      }
      try {
        const output = execFileSync('reg', [
          'QUERY',
          windowsNativeMessagingHostRegistryKey(hostName),
          '/ve',
        ], { stdio: 'pipe' }).toString();
        return parseDefaultRegistryString(output);
      } catch {
        return undefined;
      }
    },
    registerHost(hostName: string, manifestPath: string): boolean {
      if (process.platform !== 'win32') {
        return true;
      }
      try {
        execFileSync('reg', [
          'ADD',
          windowsNativeMessagingHostRegistryKey(hostName),
          '/ve',
          '/t',
          'REG_SZ',
          '/d',
          manifestPath,
          '/f',
        ], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    unregisterHost(hostName: string): boolean {
      if (process.platform !== 'win32') {
        return true;
      }
      try {
        execFileSync('reg', [
          'DELETE',
          windowsNativeMessagingHostRegistryKey(hostName),
          '/f',
        ], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function windowsNativeMessagingHostRegistryKey(hostName: string): string {
  return `${CHROME_NATIVE_MESSAGING_REGISTRY_ROOT}\\${hostName}`;
}

function parseDefaultRegistryString(output: string): string | undefined {
  const valueLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\bREG_SZ\b/.test(line));
  if (!valueLine) {
    return undefined;
  }
  const match = /\bREG_SZ\b\s+(.+)$/.exec(valueLine);
  return match?.[1]?.trim() || undefined;
}
