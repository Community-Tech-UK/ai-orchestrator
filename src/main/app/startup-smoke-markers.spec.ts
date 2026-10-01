import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getStartupSmokeDirectory,
  STARTUP_SMOKE_PID_MARKER,
  writeStartupSmokePidMarker,
} from './startup-smoke-markers';

const smokeEnv = { AIO_STARTUP_SMOKE: '1', AIO_STARTUP_SMOKE_USER_DATA_PATH: '/tmp/harness-startup-smoke-x' };

describe('startup smoke markers', () => {
  it('only resolves a smoke directory for a packaged smoke run', () => {
    expect(getStartupSmokeDirectory({ isPackaged: true, env: smokeEnv }))
      .toBe('/tmp/harness-startup-smoke-x');
    expect(getStartupSmokeDirectory({ isPackaged: false, env: smokeEnv })).toBeNull();
    expect(getStartupSmokeDirectory({
      isPackaged: true,
      env: { AIO_STARTUP_SMOKE_USER_DATA_PATH: '/tmp/harness-startup-smoke-x' },
    })).toBeNull();
    expect(getStartupSmokeDirectory({ isPackaged: true, env: { AIO_STARTUP_SMOKE: '1' } })).toBeNull();
  });

  it('publishes the running pid into the smoke profile', () => {
    const writeFileSync = vi.fn();

    writeStartupSmokePidMarker({ isPackaged: true, env: smokeEnv, pid: 4242 }, writeFileSync);

    expect(writeFileSync).toHaveBeenCalledWith(
      join('/tmp/harness-startup-smoke-x', STARTUP_SMOKE_PID_MARKER),
      '4242\n',
      'utf8',
    );
  });

  it('writes nothing outside a packaged smoke run', () => {
    const writeFileSync = vi.fn();

    writeStartupSmokePidMarker({ isPackaged: false, env: smokeEnv, pid: 4242 }, writeFileSync);
    writeStartupSmokePidMarker({ isPackaged: true, env: {}, pid: 4242 }, writeFileSync);

    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
