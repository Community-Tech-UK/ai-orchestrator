import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeRuntimeMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  homedir: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: { execFileSync: nativeRuntimeMocks.execFileSync },
  execFileSync: nativeRuntimeMocks.execFileSync,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: {
      ...actual,
      homedir: nativeRuntimeMocks.homedir,
    },
    homedir: nativeRuntimeMocks.homedir,
  };
});

import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_NATIVE_HOST_NAME,
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
  browserExtensionNativeHostManifestPath,
  prepareBrowserExtensionNativeHostRuntime,
  removeBrowserExtensionNativeHostRuntime,
} from './browser-extension-native-runtime';

const AIO_MCP = '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp';
const originalPlatform = process.platform;

describe('browser extension native runtime', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    nativeRuntimeMocks.execFileSync.mockReset();
    nativeRuntimeMocks.homedir.mockReturnValue(process.env['HOME'] ?? '/tmp');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes runtime config + Chrome native-messaging manifest pointing at the configured native-host command', () => {
    const tempDir = tempDirWithPrefix('browser-native-runtime-');
    const result = prepareBrowserExtensionNativeHostRuntime({
      userDataPath: tempDir,
      socketPath: path.join(tempDir, 'browser.sock'),
      extensionToken: 'native-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
      now: () => 1234,
    });

    expect(JSON.parse(fs.readFileSync(result.runtimeConfigPath, 'utf-8'))).toEqual({
      socketPath: path.join(tempDir, 'browser.sock'),
      extensionToken: 'native-token',
      updatedAt: 1234,
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.wrapperPath).mode & 0o111).not.toBe(0);
    } else {
      expect(path.extname(result.wrapperPath).toLowerCase()).toBe('.cmd');
    }

    const wrapper = fs.readFileSync(result.wrapperPath, 'utf-8');
    // The wrapper should invoke the configured host command; no
    // ELECTRON_RUN_AS_NODE indirection any more.
    expect(wrapper).toContain(AIO_MCP);
    expect(wrapper).toContain('native-host');
    expect(wrapper).not.toContain('ELECTRON_RUN_AS_NODE');

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf-8'));
    expect(manifest).toMatchObject({
      name: BROWSER_EXTENSION_NATIVE_HOST_NAME,
      type: 'stdio',
      path: result.wrapperPath,
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
    });
  });

  it('uses disjoint manifest, wrapper, runtime, and registry names for the relay host', () => {
    setPlatform('win32');
    const homeDir = scratchDirWithPrefix('browser-native-home-');
    const userDataPath = scratchDirWithPrefix('browser-native-user-data-');
    nativeRuntimeMocks.homedir.mockReturnValue(homeDir);

    const legacy = prepareBrowserExtensionNativeHostRuntime({
      userDataPath,
      socketPath: path.join(userDataPath, 'legacy.sock'),
      extensionToken: 'legacy-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
    });
    const relay = prepareBrowserExtensionNativeHostRuntime({
      userDataPath,
      socketPath: path.join(userDataPath, 'relay.sock'),
      extensionToken: 'relay-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      hostName: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
    });

    expect(relay.manifestPath).toBe(
      browserExtensionNativeHostManifestPath(undefined, BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME),
    );
    expect(relay.manifestPath).not.toBe(legacy.manifestPath);
    expect(relay.wrapperPath).not.toBe(legacy.wrapperPath);
    expect(relay.runtimeConfigPath).not.toBe(legacy.runtimeConfigPath);
    expect(JSON.parse(fs.readFileSync(relay.manifestPath, 'utf-8'))).toMatchObject({
      name: BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME,
      path: relay.wrapperPath,
    });
    expect(nativeRuntimeMocks.execFileSync).toHaveBeenLastCalledWith('reg', [
      'ADD',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME}`,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      relay.manifestPath,
      '/f',
    ], { stdio: 'ignore' });
  });

  it('does not write the Windows registry for explicit temp native-messaging directories', () => {
    setPlatform('win32');
    const tempDir = tempDirWithPrefix('browser-native-runtime-');

    prepareBrowserExtensionNativeHostRuntime({
      userDataPath: tempDir,
      socketPath: path.join(tempDir, 'browser.sock'),
      extensionToken: 'native-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
    });

    expect(nativeRuntimeMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('writes the Windows registry for default native-messaging directories', () => {
    setPlatform('win32');
    const homeDir = scratchDirWithPrefix('browser-native-home-');
    const userDataPath = scratchDirWithPrefix('browser-native-user-data-');
    nativeRuntimeMocks.homedir.mockReturnValue(homeDir);

    const result = prepareBrowserExtensionNativeHostRuntime({
      userDataPath,
      socketPath: path.join(userDataPath, 'browser.sock'),
      extensionToken: 'native-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
    });

    expect(nativeRuntimeMocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(nativeRuntimeMocks.execFileSync).toHaveBeenCalledWith('reg', [
      'ADD',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_EXTENSION_NATIVE_HOST_NAME}`,
      '/ve',
      '/t',
      'REG_SZ',
      '/d',
      result.manifestPath,
      '/f',
    ], { stdio: 'ignore' });
  });

  it('throws when Windows registry registration fails', () => {
    setPlatform('win32');
    const homeDir = scratchDirWithPrefix('browser-native-home-');
    const userDataPath = scratchDirWithPrefix('browser-native-user-data-');
    nativeRuntimeMocks.homedir.mockReturnValue(homeDir);
    nativeRuntimeMocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('reg failed');
    });

    expect(() => prepareBrowserExtensionNativeHostRuntime({
      userDataPath,
      socketPath: path.join(userDataPath, 'browser.sock'),
      extensionToken: 'native-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
    })).toThrow(`windows_native_messaging_registration_failed:${BROWSER_EXTENSION_NATIVE_HOST_NAME}`);
  });

  it('refuses explicit Windows registry writes for temp native-messaging directories', () => {
    setPlatform('win32');
    const tempDir = tempDirWithPrefix('browser-native-runtime-');

    expect(() => prepareBrowserExtensionNativeHostRuntime({
      userDataPath: tempDir,
      socketPath: path.join(tempDir, 'browser.sock'),
      extensionToken: 'native-token',
      hostCommand: { exe: AIO_MCP, args: ['native-host'] },
      chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
      registerInOS: true,
    })).toThrow(/Refusing to touch Windows native host registration under temp directory/);
    expect(nativeRuntimeMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not delete the Windows registry key for explicit temp native-messaging directories', () => {
    setPlatform('win32');
    const tempDir = tempDirWithPrefix('browser-native-runtime-');

    removeBrowserExtensionNativeHostRuntime({
      userDataPath: tempDir,
      chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
    });

    expect(nativeRuntimeMocks.execFileSync).not.toHaveBeenCalled();
  });

  it('deletes the Windows registry key for default native-messaging directories', () => {
    setPlatform('win32');
    const homeDir = scratchDirWithPrefix('browser-native-home-');
    const userDataPath = scratchDirWithPrefix('browser-native-user-data-');
    nativeRuntimeMocks.homedir.mockReturnValue(homeDir);

    removeBrowserExtensionNativeHostRuntime({ userDataPath });

    expect(nativeRuntimeMocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(nativeRuntimeMocks.execFileSync).toHaveBeenCalledWith('reg', [
      'DELETE',
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_EXTENSION_NATIVE_HOST_NAME}`,
      '/f',
    ], { stdio: 'ignore' });
  });

  it('refuses explicit Windows registry removal for temp native-messaging directories', () => {
    setPlatform('win32');
    const tempDir = tempDirWithPrefix('browser-native-runtime-');

    expect(() => removeBrowserExtensionNativeHostRuntime({
      userDataPath: tempDir,
      chromeNativeMessagingDir: path.join(tempDir, 'Chrome', 'NativeMessagingHosts'),
      registerInOS: true,
    })).toThrow(/Refusing to touch Windows native host registration under temp directory/);
    expect(nativeRuntimeMocks.execFileSync).not.toHaveBeenCalled();
  });

  function tempDirWithPrefix(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function scratchDirWithPrefix(prefix: string): string {
    const scratchRoot = path.join(process.cwd(), '_scratch');
    fs.mkdirSync(scratchRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratchRoot, prefix));
    tempDirs.push(dir);
    return dir;
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});
