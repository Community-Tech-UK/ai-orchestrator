import { describe, expect, it } from 'vitest';
import { resolveHarnessUserDataPath } from './user-data-path';

describe('resolveHarnessUserDataPath', () => {
  it('keeps packaged and development state separate by default', () => {
    expect(resolveHarnessUserDataPath({
      appDataPath: '/home/james/app-data',
      isPackaged: true,
      env: {},
    })).toBe('/home/james/app-data/harness');
    expect(resolveHarnessUserDataPath({
      appDataPath: '/home/james/app-data',
      isPackaged: false,
      env: {},
    })).toBe('/home/james/app-data/harness-dev');
  });

  it('uses an absolute isolated directory for packaged startup smoke tests', () => {
    expect(resolveHarnessUserDataPath({
      appDataPath: '/home/james/app-data',
      isPackaged: true,
      env: {
        AIO_STARTUP_SMOKE: '1',
        AIO_STARTUP_SMOKE_USER_DATA_PATH: '/tmp/harness-smoke',
      },
    })).toBe('/tmp/harness-smoke');
  });

  it('ignores the override unless packaged startup smoke is explicitly enabled', () => {
    expect(resolveHarnessUserDataPath({
      appDataPath: '/home/james/app-data',
      isPackaged: true,
      env: { AIO_STARTUP_SMOKE_USER_DATA_PATH: '/tmp/harness-smoke' },
    })).toBe('/home/james/app-data/harness');
  });

  it('rejects a relative startup-smoke directory', () => {
    expect(() => resolveHarnessUserDataPath({
      appDataPath: '/home/james/app-data',
      isPackaged: true,
      env: {
        AIO_STARTUP_SMOKE: '1',
        AIO_STARTUP_SMOKE_USER_DATA_PATH: '../shared-state',
      },
    })).toThrow('AIO_STARTUP_SMOKE_USER_DATA_PATH must be absolute');
  });
});
