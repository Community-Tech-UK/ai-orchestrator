import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import {
  _setSignalFenceSettingForTesting,
  isSignalFenceSettingEnabled,
} from './signal-fence-setting';

describe('isSignalFenceSettingEnabled', () => {
  afterEach(() => _setSignalFenceSettingForTesting(null));

  it('defaults to fenced', () => {
    expect(DEFAULT_SETTINGS.providerSignalFenceEnabled).toBe(true);
    // With no override the settings read either returns the default or fails;
    // both keep the fence on.
    expect(isSignalFenceSettingEnabled()).toBe(true);
  });

  it('reports the operator switch', () => {
    _setSignalFenceSettingForTesting(false);
    expect(isSignalFenceSettingEnabled()).toBe(false);
    _setSignalFenceSettingForTesting(true);
    expect(isSignalFenceSettingEnabled()).toBe(true);
  });
});
