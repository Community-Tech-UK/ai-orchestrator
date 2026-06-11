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
  browserExtensionNativeHostManifestPath: vi.fn(() => extensionRelayCliMocks.manifestPath),
  prepareBrowserExtensionNativeHostRuntime: extensionRelayCliMocks.prepareNativeHost,
  removeBrowserExtensionNativeHostRuntime: extensionRelayCliMocks.removeNativeHost,
}));

import { parseServiceArgs, runServiceCommand } from './service-cli';

describe('service-cli', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    extensionRelayCliMocks.manifestPath = 'C:\\manifest.json';
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
      'COPILOT_GITHUB_TOKEN=github_pat_x',
      '--service-env',
      'GH_TOKEN=gho_y',
    ])).toMatchObject({
      kind: 'install',
      coordinatorUrl: 'ws://mac:4878',
      serviceAccount: '.\\James',
      serviceEnv: {
        COPILOT_GITHUB_TOKEN: 'github_pat_x',
        GH_TOKEN: 'gho_y',
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
      'COPILOT_GITHUB_TOKEN=github_pat_x',
    ]);

    await runServiceCommand(command!);

    expect(mockInstall).toHaveBeenCalledWith(expect.objectContaining({
      serviceAccount: '.\\James',
      environment: {
        COPILOT_GITHUB_TOKEN: 'github_pat_x',
      },
    }));
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
      userDataPath: expect.any(String),
    }));
  });
});
