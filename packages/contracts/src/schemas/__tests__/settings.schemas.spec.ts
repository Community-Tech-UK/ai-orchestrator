import { describe, expect, it } from 'vitest';
import {
  SettingsGetPayloadSchema,
  SettingsUpdatePayloadSchema,
  SettingsBulkUpdatePayloadSchema,
  SettingsResetOnePayloadSchema,
  SettingsSetPayloadSchema,
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
});
