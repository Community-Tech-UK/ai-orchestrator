import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../../shared/types/settings.types';

const settingsMocks = vi.hoisted(() => ({
  allSettings: {} as AppSettings,
  getAll: vi.fn(() => settingsMocks.allSettings),
  update: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
}));

vi.mock('./settings-manager', () => ({
  getSettingsManager: () => settingsMocks,
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  applyImport,
  buildExportData,
} from './settings-export';

describe('settings export/import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsMocks.allSettings = {
      theme: 'light',
      fontSize: 16,
      defaultCli: 'codex',
      defaultWorkingDirectory: '/Users/james/work/project',
      remoteNodesEnrollmentToken: 'secret-token',
      remoteNodesRegisteredNodes: '{"node":"secret-node"}',
      auxiliaryLlmEndpointsJson: '[{"apiKey":"secret"}]',
      projectPluginTrust: { '/Users/james/work/project': 'trusted' },
    } as AppSettings;
  });

  it('exports only portable non-secret settings', () => {
    const data = buildExportData();

    expect(data.appSettings).toMatchObject({
      theme: 'light',
      fontSize: 16,
      defaultCli: 'codex',
    });
    expect(data.appSettings).not.toHaveProperty('defaultWorkingDirectory');
    expect(data.appSettings).not.toHaveProperty('remoteNodesEnrollmentToken');
    expect(data.appSettings).not.toHaveProperty('remoteNodesRegisteredNodes');
    expect(data.appSettings).not.toHaveProperty('auxiliaryLlmEndpointsJson');
    expect(data.appSettings).not.toHaveProperty('projectPluginTrust');
    expect(data.skippedSettings).toEqual([
      'auxiliaryLlmEndpointsJson',
      'defaultWorkingDirectory',
      'projectPluginTrust',
      'remoteNodesEnrollmentToken',
      'remoteNodesRegisteredNodes',
    ]);
    expect(JSON.stringify(data)).not.toContain('secret-token');
    expect(JSON.stringify(data)).not.toContain('secret-node');
  });

  it('skips non-portable and unknown keys during import', () => {
    const result = applyImport({
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '1.2.3',
      appSettings: {
        theme: 'dark',
        fontSize: 15,
        defaultWorkingDirectory: '/Users/other/work',
        remoteNodesEnrollmentToken: 'secret-token',
        futureSetting: true,
      } as Partial<AppSettings> & Record<string, unknown>,
      skippedSettings: [],
    });

    expect(result).toEqual({
      settingsRestored: true,
      settingsImported: 2,
      settingsSkipped: 3,
    });
    expect(settingsMocks.update).toHaveBeenCalledWith({
      theme: 'dark',
      fontSize: 15,
    });
  });
});
