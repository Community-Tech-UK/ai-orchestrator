import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: loggerMocks.info,
    warn: vi.fn(),
  }),
}));

vi.mock('../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: vi.fn(() => {
    throw new Error('better-sqlite3 should not be touched when toolFactory is injected');
  }),
}));

vi.mock('../operator/operator-schema', () => ({
  createOperatorTables: vi.fn(),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/never-opened.db',
}));

import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import {
  OrchestratorToolsRpcServer,
  _resetOrchestratorToolsRpcServerForTesting,
} from './orchestrator-tools-rpc-server';
import { createSettingsToolDefinitions } from './orchestrator-settings-tools';

const KNOWN_INSTANCE = 'instance-known';

function cloneSettings(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

function makeSettingsManager(initial: Partial<AppSettings> = {}) {
  const values: AppSettings = { ...cloneSettings(), ...initial };
  return {
    values,
    getAll: vi.fn(() => ({ ...values })),
    get: vi.fn(<K extends keyof AppSettings>(key: K) => values[key]),
    set: vi.fn(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      values[key] = value;
    }),
    resetOne: vi.fn(<K extends keyof AppSettings>(key: K) => {
      values[key] = DEFAULT_SETTINGS[key];
    }),
  };
}

describe('OrchestratorToolsRpcServer settings integration', () => {
  afterEach(() => {
    loggerMocks.info.mockClear();
    _resetOrchestratorToolsRpcServerForTesting();
  });

  it('uses the real settings tool and broadcasts renderer changes via the RPC alias', async () => {
    const settingsManager = makeSettingsManager({ theme: 'dark' });
    const broadcastSettingsChange = vi.fn();
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      broadcastSettingsChange,
      registerCleanup: () => undefined,
      toolFactory: (deps) => createSettingsToolDefinitions({
        settingsManager: deps.settingsManager,
        broadcastSettingsChange: deps.broadcastSettingsChange,
        updateNodeConfig: deps.updateNodeConfig,
      }),
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'orchestrator_tools.settings.set',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'theme', value: 'light' },
      },
    });

    expect(settingsManager.set).toHaveBeenCalledWith('theme', 'light');
    expect(broadcastSettingsChange).toHaveBeenCalledWith({ key: 'theme', value: 'light' });
    expect(result).toMatchObject({
      ok: true,
      key: 'theme',
      oldValue: 'dark',
      newValue: 'light',
    });
  });

  it('privileged_list exposes all settings with safe redaction and accepts --all payloads', async () => {
    const settingsManager = makeSettingsManager({
      remoteNodesEnrollmentToken: 'redaction-test-value',
      theme: 'dark',
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'orchestrator_tools.settings.privileged_list',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { category: 'remote-nodes', all: true },
      },
    }) as {
      settings: { key: keyof AppSettings; value: unknown; policyTier: string }[];
    };

    expect(result.settings.find((setting) => setting.key === 'remoteNodesEnrollmentToken'))
      .toMatchObject({
        value: '[redacted]',
        policyTier: 'secret',
      });
    expect(JSON.stringify(result)).not.toContain('redaction-test-value');
  });

  it('privileged_get refuses secret keys instead of returning their value', async () => {
    const settingsManager = makeSettingsManager({
      remoteNodesEnrollmentToken: 'redaction-test-value',
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'orchestrator_tools.settings.privileged_get',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { key: 'remoteNodesEnrollmentToken' },
        },
      }),
    ).rejects.toThrow(/secret setting/);
  });

  it('privileged_set can update read-only safe-MCP keys through renderer-compatible coercion', async () => {
    const settingsManager = makeSettingsManager({ remoteNodesEnabled: false });
    const broadcastSettingsChange = vi.fn();
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      broadcastSettingsChange,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'orchestrator_tools.settings.privileged_set',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'remoteNodesEnabled', value: true },
      },
    });

    expect(settingsManager.set).toHaveBeenCalledWith('remoteNodesEnabled', true);
    expect(broadcastSettingsChange).toHaveBeenCalledWith({
      key: 'remoteNodesEnabled',
      value: true,
    });
    expect(result).toMatchObject({
      ok: true,
      key: 'remoteNodesEnabled',
      oldValue: false,
      newValue: true,
      restartRequired: true,
    });
  });

  it('privileged_set validates payloads before invoking SettingsManager', async () => {
    const settingsManager = makeSettingsManager({ theme: 'dark' });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'orchestrator_tools.settings.privileged_set',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { key: 'theme', value: 'light', extra: true },
        },
      }),
    ).rejects.toThrow();
    expect(settingsManager.set).not.toHaveBeenCalled();
  });

  it('keeps credential-vault unlock anchors operator-only in privileged mode', async () => {
    const settingsManager = makeSettingsManager({
      browserVaultMasterPasswordFile: '',
      browserVaultAutoUnlock: false,
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 51,
      method: 'orchestrator_tools.settings.privileged_set',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'browserVaultAutoUnlock', value: true },
      },
    })).rejects.toThrow(/operator-only/);
    await expect(server.handleRequest({
      jsonrpc: '2.0',
      id: 52,
      method: 'orchestrator_tools.settings.privileged_reset',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'browserVaultMasterPasswordFile' },
      },
    })).rejects.toThrow(/operator-only/);

    expect(settingsManager.set).not.toHaveBeenCalled();
    expect(settingsManager.resetOne).not.toHaveBeenCalled();
  });

  it('keeps Computer Use policy operator-only in privileged mode', async () => {
    const settingsManager = makeSettingsManager({
      computerUseEnabled: false,
      computerUseRequireApprovalForInput: true,
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    for (const [key, value] of [
      ['computerUseEnabled', true],
      ['computerUseAllowedAppsJson', '["com.example.untrusted"]'],
      ['computerUseDeniedAppsJson', '[]'],
      ['computerUseRequireApprovalForInput', false],
      ['computerUseStoreScreenshotsForEscalations', true],
    ] as const) {
      await expect(server.handleRequest({
        jsonrpc: '2.0',
        id: `computer-use-${key}`,
        method: 'orchestrator_tools.settings.privileged_set',
        params: {
          instanceId: KNOWN_INSTANCE,
          payload: { key, value },
        },
      })).rejects.toThrow(/operator-only/);
    }

    expect(settingsManager.set).not.toHaveBeenCalled();
  });

  it('privileged_set redacts secret old and new values in results and logs', async () => {
    const settingsManager = makeSettingsManager({
      remoteNodesEnrollmentToken: 'previous-redaction-test-value',
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'orchestrator_tools.settings.privileged_set',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'remoteNodesEnrollmentToken', value: 'replacement-redaction-test-value' },
      },
    });

    expect(settingsManager.set).toHaveBeenCalledWith(
      'remoteNodesEnrollmentToken',
      'replacement-redaction-test-value',
    );
    expect(result).toEqual({
      ok: true,
      key: 'remoteNodesEnrollmentToken',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      restartRequired: false,
    });
    expect(loggerMocks.info).toHaveBeenCalledWith('Setting changed via privileged settings CLI', {
      source: 'privileged-settings-cli',
      action: 'privileged_set',
      key: 'remoteNodesEnrollmentToken',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      restartRequired: false,
    });
    expect(JSON.stringify(loggerMocks.info.mock.calls)).not.toContain('previous-redaction-test-value');
    expect(JSON.stringify(loggerMocks.info.mock.calls)).not.toContain('replacement-redaction-test-value');
  });

  it('privileged_reset can reset secret keys while reporting only redacted values', async () => {
    const settingsManager = makeSettingsManager({
      remoteNodesEnrollmentToken: 'previous-redaction-test-value',
    });
    const server = new OrchestratorToolsRpcServer({
      userDataPath: os.tmpdir(),
      isKnownLocalInstance: (id) => id === KNOWN_INSTANCE,
      settingsManager,
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'orchestrator_tools.settings.privileged_reset',
      params: {
        instanceId: KNOWN_INSTANCE,
        payload: { key: 'remoteNodesEnrollmentToken' },
      },
    });

    expect(settingsManager.resetOne).toHaveBeenCalledWith('remoteNodesEnrollmentToken');
    expect(result).toEqual({
      ok: true,
      key: 'remoteNodesEnrollmentToken',
      oldValue: '[redacted]',
      newValue: '[redacted]',
      restartRequired: false,
    });
  });
});
