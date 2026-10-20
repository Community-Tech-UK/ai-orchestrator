import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerModeSettings } from '../../shared/types/pair-both.types';

vi.mock('electron', () => ({
  app: { isPackaged: true, setLoginItemSettings: vi.fn() },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => {
    throw new Error('tests must inject settings');
  },
}));

import { bindWorkerModeLoginItem, wantsOpenAtLogin } from './worker-mode-login-item';

const base: WorkerModeSettings = {
  role: 'worker',
  startWorkerOnLaunch: true,
  installWorkerService: false,
};

function fakeSettings(initial: WorkerModeSettings) {
  const emitter = new EventEmitter();
  let current = initial;
  return {
    get: () => current,
    on: (event: 'setting:workerMode', listener: (value: WorkerModeSettings) => void) =>
      emitter.on(event, listener),
    change(next: WorkerModeSettings) {
      current = next;
      emitter.emit('setting:workerMode', next);
    },
  };
}

describe('bindWorkerModeLoginItem', () => {
  it('only wants a login item for a worker that opted in', () => {
    expect(wantsOpenAtLogin({ ...base, openAtLogin: true })).toBe(true);
    expect(wantsOpenAtLogin({ ...base })).toBe(false);
    expect(wantsOpenAtLogin({ ...base, role: 'coordinator', openAtLogin: true })).toBe(false);
  });

  it('registers at startup when wanted, and never unregisters at startup', () => {
    const on = vi.fn();
    bindWorkerModeLoginItem({
      settings: fakeSettings({ ...base, openAtLogin: true }),
      applyLoginItem: on,
      platform: 'win32',
      isPackaged: true,
    });
    expect(on).toHaveBeenCalledWith(true);

    const off = vi.fn();
    bindWorkerModeLoginItem({
      settings: fakeSettings({ ...base, openAtLogin: false }),
      applyLoginItem: off,
      platform: 'win32',
      isPackaged: true,
    });
    expect(off).not.toHaveBeenCalled();
  });

  it('follows the option and the worker role as they change', () => {
    const settings = fakeSettings({ ...base });
    const apply = vi.fn();
    bindWorkerModeLoginItem({ settings, applyLoginItem: apply, platform: 'darwin', isPackaged: true });

    settings.change({ ...base, openAtLogin: true });
    settings.change({ ...base, openAtLogin: true, lastCoordinatorName: 'Mac' });
    settings.change({ ...base, role: 'coordinator', openAtLogin: true });
    settings.change({ ...base, role: 'worker', openAtLogin: true });

    expect(apply.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('does nothing on Linux or in an unpackaged dev build', () => {
    const apply = vi.fn();
    bindWorkerModeLoginItem({
      settings: fakeSettings({ ...base, openAtLogin: true }),
      applyLoginItem: apply,
      platform: 'linux',
      isPackaged: true,
    });
    bindWorkerModeLoginItem({
      settings: fakeSettings({ ...base, openAtLogin: true }),
      applyLoginItem: apply,
      platform: 'win32',
      isPackaged: false,
    });
    expect(apply).not.toHaveBeenCalled();
  });

  it('survives an OS refusal', () => {
    const settings = fakeSettings({ ...base });
    const apply = vi.fn(() => { throw new Error('denied'); });
    bindWorkerModeLoginItem({ settings, applyLoginItem: apply, platform: 'win32', isPackaged: true });

    expect(() => settings.change({ ...base, openAtLogin: true })).not.toThrow();
  });
});
