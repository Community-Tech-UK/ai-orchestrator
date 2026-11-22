import { describe, expect, it } from 'vitest';
import { resolveUserRulesFilePath } from './user-rules-path';

describe('resolveUserRulesFilePath', () => {
  const home = '/home/someone';
  it('uses the real home for a normal app', () => {
    expect(resolveUserRulesFilePath({ home, isPackaged: false, env: {} })).toBe('/home/someone/.orchestrator/permissions.json');
    expect(resolveUserRulesFilePath({ home, isPackaged: true, env: {} })).toBe('/home/someone/.orchestrator/permissions.json');
  });
  it('keeps an isolated unpackaged dev profile away from the real home', () => {
    expect(resolveUserRulesFilePath({ home, isPackaged: false, env: { AIO_DEV_USER_DATA_PATH: '/tmp/profile' } }))
      .toBe('/tmp/profile/permissions.json');
  });
  it('ignores the override for a packaged app', () => {
    expect(resolveUserRulesFilePath({ home, isPackaged: true, env: { AIO_DEV_USER_DATA_PATH: '/tmp/profile' } }))
      .toBe('/home/someone/.orchestrator/permissions.json');
  });
  it('has no path without a home or a profile', () => {
    expect(resolveUserRulesFilePath({ home: null, isPackaged: false, env: {} })).toBeNull();
  });
});
