import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceManager } from '../service/types';

const mockInstall = vi.fn();
const mockUninstall = vi.fn();
const mockStatus = vi.fn();
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRestart = vi.fn();
const mockIsInstalled = vi.fn();

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
  persistConfig: vi.fn(),
}));

import { parseServiceArgs, runServiceCommand } from './service-cli';

describe('service-cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
