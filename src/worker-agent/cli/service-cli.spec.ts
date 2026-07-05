import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceManager } from '../service/types';

const mockInstall = vi.fn();
const mockUninstall = vi.fn();
const mockStatus = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRestart = vi.fn();
const mockIsInstalled = vi.fn();
const extensionRelayCliMocks = vi.hoisted(() => ({
  manifestPath: 'C:\\manifest.json',
  persistConfig: vi.fn(),
  assertManifestWritable: vi.fn(),
  isManifestOwned: vi.fn(() => true),
  nativeHostPaths: vi.fn(() => ({
    nativeDir: 'C:\\Users\\James\\.orchestrator\\browser-gateway\\native-host',
  })),
  prepareNativeHost: vi.fn(() => ({ manifestPath: 'C:\\manifest.json' })),
  removeNativeHost: vi.fn(() => ({ manifestPath: 'C:\\manifest.json' })),
}));

vi.mock('../service/manager-factory', () => ({
  createServiceManager: vi.fn(async (): Promise<ServiceManager> => ({
    install: mockInstall,
    uninstall: mockUninstall,
    status: mockStatus,
    start: mockStart,
    stop: mockStop,
    restart: mockRestart,
    isInstalled: mockIsInstalled,
  })),
}));

vi.mock('../service/privilege', () => ({
  isElevated: vi.fn(async () => true),
  NotElevatedError: class NotElevatedError extends Error {},
}));

vi.mock('../service/token-resolver', () => ({
  resolveToken: vi.fn(async () => ({ token: 'pairing-token' })),
}));

vi.mock('../service/paths', () => ({
  servicePaths: vi.fn(() => ({
    configDir: 'C:\\ProgramData\\Orchestrator',
    configFile: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
    binDir: 'C:\\Program Files\\Orchestrator\\bin',
    binFile: 'C:\\Program Files\\Orchestrator\\bin\\current\\worker-agent.exe',
    currentBinLink: 'C:\\Program Files\\Orchestrator\\bin\\current',
    versionedBinDir: 'C:\\Program Files\\Orchestrator\\bin\\versions',
    logDir: 'C:\\ProgramData\\Orchestrator\\logs',
    pluginDir: 'C:\\ProgramData\\Orchestrator\\plugins',
  })),
}));

vi.mock('../service/config-migration', () => ({
  migrateConfigIfNeeded: vi.fn(async () => undefined),
}));

vi.mock('../worker-config', () => ({
  DEFAULT_CONFIG_PATH: 'C:\\Users\\James\\.orchestrator\\worker-node.json',
  defaultExtensionRelaySocketPath: vi.fn(() => '\\\\.\\pipe\\ai-orchestrator-browser-gateway'),
  ensureExtensionRelayDefaults: vi.fn((config, defaultSocketPath) => ({
    ...config,
    enabled: config?.enabled === true,
    socketPath: config?.socketPath ?? defaultSocketPath(),
    extensionToken: config?.extensionToken ?? 'generated-extension-token',
  })),
  normalizeCoordinatorUrl: vi.fn((value: unknown) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return undefined;
    }
    const url = new URL(value.trim());
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return undefined;
    }
    url.search = '';
    url.hash = '';
    return url.pathname === '/' ? `${url.protocol}//${url.host}` : url.toString();
  }),
  loadWorkerConfig: vi.fn(() => ({
    nodeId: 'node-1',
    name: 'windows-pc',
    authToken: 'old-token',
    namespace: 'default',
    maxConcurrentInstances: 10,
    workingDirectories: ['C:\\Users\\James\\Work'],
    reconnectIntervalMs: 5000,
    heartbeatIntervalMs: 10000,
  })),
  persistConfig: extensionRelayCliMocks.persistConfig,
}));

vi.mock('../../main/browser-gateway/browser-extension-native-runtime', () => ({
  BROWSER_EXTENSION_NATIVE_HOST_NAME: 'com.ai_orchestrator.browser_gateway',
  BROWSER_EXTENSION_RELAY_NATIVE_HOST_NAME: 'com.ai_orchestrator.browser_gateway_relay',
  assertBrowserExtensionNativeHostManifestWritable: extensionRelayCliMocks.assertManifestWritable,
  isBrowserExtensionNativeHostManifestOwned: extensionRelayCliMocks.isManifestOwned,
  browserExtensionNativeHostPaths: extensionRelayCliMocks.nativeHostPaths,
  browserExtensionNativeHostManifestPath: vi.fn(() => extensionRelayCliMocks.manifestPath),
  prepareBrowserExtensionNativeHostRuntime: extensionRelayCliMocks.prepareNativeHost,
  removeBrowserExtensionNativeHostRuntime: extensionRelayCliMocks.removeNativeHost,
}));

import { parseServiceArgs, runServiceCommand } from './service-cli';
import { loadWorkerConfig } from '../worker-config';

describe('service-cli', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    extensionRelayCliMocks.manifestPath = 'C:\\manifest.json';
    extensionRelayCliMocks.nativeHostPaths.mockReturnValue({
      nativeDir: 'C:\\Users\\James\\.orchestrator\\browser-gateway\\native-host',
    });
    extensionRelayCliMocks.isManifestOwned.mockReturnValue(true);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-service-cli-'));
    tempDirs.push(dir);
    return dir;
  }

  it('parses service account and service env install options', () => {
    expect(parseServiceArgs([
      '--install-service',
      '--coordinator-url',
      'ws://mac:4878',
      '--token-env',
      'AIO_TOKEN',
      '--service-account',
      '.\\James',
      '--service-env',
      'COPILOT_GITHUB_TOKEN=copilot-token-placeholder',
      '--service-env',
      'GH_TOKEN=gh-token-placeholder',
    ])).toMatchObject({
      kind: 'install',
      coordinatorUrl: 'ws://mac:4878',
      serviceAccount: '.\\James',
      serviceEnv: {
        COPILOT_GITHUB_TOKEN: 'copilot-token-placeholder',
        GH_TOKEN: 'gh-token-placeholder',
      },
    });
  });

  it('passes service account and env through to the service manager', async () => {
    const command = parseServiceArgs([
      '--install-service',
      '--coordinator-url',
      'ws://mac:4878',
      '--token-env',
      'AIO_TOKEN',
      '--service-account',
      '.\\James',
      '--service-env',
      'COPILOT_GITHUB_TOKEN=copilot-token-placeholder',
    ]);

    await runServiceCommand(command!);

    expect(mockInstall).toHaveBeenCalledWith(expect.objectContaining({
      serviceAccount: '.\\James',
      environment: {
        COPILOT_GITHUB_TOKEN: 'copilot-token-placeholder',
      },
    }));
  });

  it('clears stale node credentials when installing with a new pairing token', async () => {
    vi.mocked(loadWorkerConfig).mockReturnValueOnce({
      nodeId: 'node-1',
      name: 'windows-pc',
      authToken: 'old-token',
      nodeToken: 'old-node-token',
      recoveryToken: 'old-recovery-token',
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: ['C:\\Users\\James\\Work'],
      reconnectIntervalMs: 5000,
      heartbeatIntervalMs: 10000,
    });
    const command = parseServiceArgs([
      '--install-service',
      '--coordinator-url',
      'ws://mac:4878',
    ]);

    await runServiceCommand(command!);

    const persisted = extensionRelayCliMocks.persistConfig.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(persisted).toMatchObject({
      authToken: 'pairing-token',
      coordinatorUrl: 'ws://mac:4878',
    });
    expect(persisted).not.toHaveProperty('nodeToken');
    expect(persisted).not.toHaveProperty('recoveryToken');
  });

  it('strips query and fragment data from service install coordinator URLs', async () => {
    const command = parseServiceArgs([
      '--install-service',
      '--coordinator-url',
      'wss://mac.tail4fc107.ts.net:4878/worker?token=secret#pairing',
    ]);

    await runServiceCommand(command!);

    const persisted = extensionRelayCliMocks.persistConfig.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(persisted.coordinatorUrl).toBe('wss://mac.tail4fc107.ts.net:4878/worker');
    expect(mockInstall).toHaveBeenCalledWith(expect.objectContaining({
      coordinatorUrl: 'wss://mac.tail4fc107.ts.net:4878/worker',
    }));
  });

  it('rejects service install coordinator URLs that are not WebSocket URLs', async () => {
    const command = parseServiceArgs([
      '--install-service',
      '--coordinator-url',
      'https://mac.tail4fc107.ts.net:4878',
    ]);

    await expect(runServiceCommand(command!)).rejects.toThrow(/must be a ws:\/\/ or wss:\/\//i);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('parses extension relay install and uninstall commands', () => {
    expect(parseServiceArgs(['--install-extension-relay', '--config', 'C:\\worker.json'])).toEqual({
      kind: 'install-extension-relay',
      configPath: 'C:\\worker.json',
    });
    expect(parseServiceArgs(['--uninstall-extension-relay'])).toEqual({
      kind: 'uninstall-extension-relay',
      configPath: undefined,
    });
    expect(parseServiceArgs(['--install-extension-relay', '--force'])).toEqual({
      kind: 'install-extension-relay',
      configPath: undefined,
      force: true,
    });
    expect(parseServiceArgs(['install-browser-extension', '--config', 'C:\\worker.json', '--force'])).toEqual({
      kind: 'install-extension-relay',
      configPath: 'C:\\worker.json',
      force: true,
    });
    expect(parseServiceArgs(['uninstall-browser-extension'])).toEqual({
      kind: 'uninstall-extension-relay',
      configPath: undefined,
    });
  });

  it('installs the extension relay native host without touching the service manager', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await runServiceCommand({
        kind: 'install-extension-relay',
        configPath: 'C:\\worker.json',
      });

      expect(mockInstall).not.toHaveBeenCalled();
      expect(extensionRelayCliMocks.persistConfig).toHaveBeenCalledWith(
        'C:\\worker.json',
        expect.objectContaining({
          extensionRelay: expect.objectContaining({
            enabled: true,
            extensionToken: 'generated-extension-token',
          }),
        }),
      );
      expect(extensionRelayCliMocks.prepareNativeHost).toHaveBeenCalledWith(expect.objectContaining({
        hostName: 'com.ai_orchestrator.browser_gateway_relay',
        userDataPath: expect.any(String),
        socketPath: '\\\\.\\pipe\\ai-orchestrator-browser-gateway',
        extensionToken: 'generated-extension-token',
      }));
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('resources/browser-extension'));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('refuses to overwrite an extension manifest owned by another runtime without force', async () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'worker.json');
    extensionRelayCliMocks.manifestPath = path.join(dir, 'native-host.json');
    fs.writeFileSync(
      extensionRelayCliMocks.manifestPath,
      JSON.stringify({ path: path.join(dir, 'coordinator-native-host') }),
      'utf-8',
    );
    extensionRelayCliMocks.assertManifestWritable.mockImplementationOnce(() => {
      throw new Error('Refusing to overwrite existing Chrome native host manifest');
    });

    await expect(runServiceCommand({
      kind: 'install-extension-relay',
      configPath,
    })).rejects.toThrow('Refusing to overwrite existing Chrome native host manifest');

    expect(extensionRelayCliMocks.prepareNativeHost).not.toHaveBeenCalled();
  });

  it('allows extension relay install over another manifest when force is explicit', async () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'worker.json');
    extensionRelayCliMocks.manifestPath = path.join(dir, 'native-host.json');
    fs.writeFileSync(
      extensionRelayCliMocks.manifestPath,
      JSON.stringify({ path: path.join(dir, 'coordinator-native-host') }),
      'utf-8',
    );

    await expect(runServiceCommand({
      kind: 'install-extension-relay',
      configPath,
      force: true,
    })).resolves.toBe(0);

    expect(extensionRelayCliMocks.prepareNativeHost).toHaveBeenCalled();
  });

  it('uninstalls the extension relay native host without touching the service manager', async () => {
    await runServiceCommand({
      kind: 'uninstall-extension-relay',
      configPath: 'C:\\worker.json',
    });

    expect(mockUninstall).not.toHaveBeenCalled();
    expect(extensionRelayCliMocks.persistConfig).toHaveBeenCalledWith(
      'C:\\worker.json',
      expect.objectContaining({
        extensionRelay: expect.objectContaining({
          enabled: false,
        }),
      }),
    );
    expect(extensionRelayCliMocks.removeNativeHost).toHaveBeenCalledWith(expect.objectContaining({
      hostName: 'com.ai_orchestrator.browser_gateway_relay',
      userDataPath: expect.any(String),
    }));
    expect(extensionRelayCliMocks.removeNativeHost).toHaveBeenCalledWith(expect.objectContaining({
      hostName: 'com.ai_orchestrator.browser_gateway',
      userDataPath: expect.any(String),
    }));
  });

  it('does not uninstall a legacy native host manifest owned by another runtime', async () => {
    extensionRelayCliMocks.isManifestOwned.mockReturnValue(false);

    await runServiceCommand({
      kind: 'uninstall-extension-relay',
      configPath: 'C:\\worker.json',
    });

    expect(extensionRelayCliMocks.removeNativeHost).toHaveBeenCalledWith(expect.objectContaining({
      hostName: 'com.ai_orchestrator.browser_gateway_relay',
    }));
    expect(extensionRelayCliMocks.removeNativeHost).not.toHaveBeenCalledWith(expect.objectContaining({
      hostName: 'com.ai_orchestrator.browser_gateway',
    }));
  });
});
