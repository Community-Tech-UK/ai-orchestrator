import { describe, expect, it } from 'vitest';
import {
  SettingsGetPayloadSchema,
  SettingsUpdatePayloadSchema,
  SettingsBulkUpdatePayloadSchema,
  SettingsResetOnePayloadSchema,
  SettingsSetPayloadSchema,
  SettingsToolGetPayloadSchema,
  SettingsToolListPayloadSchema,
  SettingsToolResetPayloadSchema,
  SettingsToolSetPayloadSchema,
  SettingsToolUpdateNodeConfigPayloadSchema,
  ConfigResolvePayloadSchema,
  ConfigGetProjectPayloadSchema,
  ConfigSaveProjectPayloadSchema,
  ConfigCreateProjectPayloadSchema,
  ConfigFindProjectPayloadSchema,
  InstructionsResolvePayloadSchema,
  InstructionsCreateDraftPayloadSchema,
  RemoteConfigFetchUrlPayloadSchema,
  RemoteConfigFetchWellKnownPayloadSchema,
  RemoteConfigFetchGitHubPayloadSchema,
  RemoteConfigDiscoverGitPayloadSchema,
  RemoteConfigInvalidatePayloadSchema,
  RemoteObserverStartPayloadSchema,
} from '../settings.schemas';

describe('settings.schemas', () => {
  it('SettingsGetPayloadSchema accepts a valid key', () => {
    expect(SettingsGetPayloadSchema.parse({ key: 'theme' })).toEqual({ key: 'theme' });
  });

  it('SettingsGetPayloadSchema rejects empty key', () => {
    expect(() => SettingsGetPayloadSchema.parse({ key: '' })).toThrow();
  });

  it('ConfigResolvePayloadSchema requires workingDirectory', () => {
    expect(() => ConfigResolvePayloadSchema.parse({})).toThrow();
  });

  it('exports all settings-group schemas as Zod schemas', () => {
    const schemas = [
      SettingsGetPayloadSchema, SettingsUpdatePayloadSchema, SettingsBulkUpdatePayloadSchema,
      SettingsResetOnePayloadSchema, SettingsSetPayloadSchema,
      SettingsToolGetPayloadSchema, SettingsToolListPayloadSchema, SettingsToolResetPayloadSchema,
      SettingsToolSetPayloadSchema, SettingsToolUpdateNodeConfigPayloadSchema,
      ConfigResolvePayloadSchema, ConfigGetProjectPayloadSchema, ConfigSaveProjectPayloadSchema,
      ConfigCreateProjectPayloadSchema, ConfigFindProjectPayloadSchema,
      InstructionsResolvePayloadSchema, InstructionsCreateDraftPayloadSchema,
      RemoteConfigFetchUrlPayloadSchema, RemoteConfigFetchWellKnownPayloadSchema,
      RemoteConfigFetchGitHubPayloadSchema, RemoteConfigDiscoverGitPayloadSchema,
      RemoteConfigInvalidatePayloadSchema, RemoteObserverStartPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });

  it('settings MCP tool schemas validate single-key settings operations', () => {
    expect(SettingsToolListPayloadSchema.parse({ category: 'display' })).toEqual({
      category: 'display',
    });
    expect(SettingsToolGetPayloadSchema.parse({ key: 'theme' })).toEqual({ key: 'theme' });
    expect(SettingsToolSetPayloadSchema.parse({ key: 'theme', value: 'light' })).toEqual({
      key: 'theme',
      value: 'light',
    });
    expect(SettingsToolResetPayloadSchema.parse({ key: 'theme' })).toEqual({ key: 'theme' });

    expect(() => SettingsToolGetPayloadSchema.parse({ key: '' })).toThrow();
    expect(() => SettingsToolListPayloadSchema.parse({ unknown: true })).toThrow();
  });

  it('requires values for settings set payloads instead of accepting omitted unknowns', () => {
    expect(() => SettingsUpdatePayloadSchema.parse({ key: 'theme' })).toThrow();
    expect(() => SettingsSetPayloadSchema.parse({ key: 'theme' })).toThrow();
    expect(() => SettingsToolSetPayloadSchema.parse({ key: 'theme' })).toThrow();
  });

  it('update_node_config schema accepts existing config.update blocks and requires one', () => {
    expect(SettingsToolUpdateNodeConfigPayloadSchema.parse({
      nodeId: 'windows-pc',
      browserAutomation: {
        enabled: true,
        profileDir: 'C:\\aio-browser',
        headless: false,
      },
      extensionRelay: { enabled: true },
    })).toEqual({
      nodeId: 'windows-pc',
      browserAutomation: {
        enabled: true,
        profileDir: 'C:\\aio-browser',
        headless: false,
      },
      extensionRelay: { enabled: true },
    });

    expect(SettingsToolUpdateNodeConfigPayloadSchema.parse({
      nodeId: 'node-1',
      androidAutomation: {
        enabled: true,
        sdkPath: 'C:\\Android\\Sdk',
        maxEmulators: 1,
      },
    })).toEqual({
      nodeId: 'node-1',
      androidAutomation: {
        enabled: true,
        sdkPath: 'C:\\Android\\Sdk',
        maxEmulators: 1,
      },
    });

    expect(SettingsToolUpdateNodeConfigPayloadSchema.parse({
      nodeId: 'windows-pc',
      fileTransfer: {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'downloads',
            label: 'Downloads',
            path: 'C:\\Users\\James\\Downloads',
            read: true,
            write: false,
          },
        ],
      },
    })).toEqual({
      nodeId: 'windows-pc',
      fileTransfer: {
        enabled: true,
        maxFileBytes: 1024,
        roots: [
          {
            id: 'downloads',
            label: 'Downloads',
            path: 'C:\\Users\\James\\Downloads',
            read: true,
            write: false,
          },
        ],
      },
    });

    expect(() =>
      SettingsToolUpdateNodeConfigPayloadSchema.parse({ nodeId: 'node-1' }),
    ).toThrow();
    expect(() =>
      SettingsToolUpdateNodeConfigPayloadSchema.parse({
        nodeId: 'node-1',
        androidAutomation: { enabled: true, maxEmulators: 5 },
      }),
    ).toThrow();
  });
});
