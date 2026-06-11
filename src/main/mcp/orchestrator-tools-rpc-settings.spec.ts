import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
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
});
