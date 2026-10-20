import { describe, expect, it, vi } from 'vitest';
import type { WorkerModeSettings } from '../../shared/types/pair-both.types';
import { EventEmitter } from 'node:events';
import {
  bindWorkerModeRoleLifecycle,
  ensureSignInWorkerOnLaunch,
  maybeStartWorkerModeOnLaunch,
  reconcileStaleWorkerServiceFlag,
} from './worker-mode-autostart';

const paired = () => ({ paired: true });
const unpaired = () => ({ paired: false });

const workerMode: WorkerModeSettings = {
  role: 'worker',
  startWorkerOnLaunch: true,
  installWorkerService: false,
};

describe('maybeStartWorkerModeOnLaunch', () => {
  it('starts the worker runtime for run-while-open worker mode when config exists', () => {
    const startRuntime = vi.fn(() => ({ state: 'running' as const, pid: 1234 }));

    const result = maybeStartWorkerModeOnLaunch({
      configPath: '/worker-node.json',
      readPairing: paired,
      getWorkerMode: () => workerMode,
      startRuntime,
    });

    expect(result).toEqual({
      started: true,
      status: { state: 'running', pid: 1234 },
    });
    expect(startRuntime).toHaveBeenCalledWith('/worker-node.json');
  });

  it('skips autostart outside worker role', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: paired,
      getWorkerMode: () => ({ ...workerMode, role: 'coordinator' }),
      startRuntime,
    });

    expect(result).toEqual({ started: false, reason: 'not-worker-role' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('skips autostart when background service owns startup', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: paired,
      getWorkerMode: () => ({
        ...workerMode,
        startWorkerOnLaunch: false,
        installWorkerService: true,
      }),
      startRuntime,
    });

    expect(result).toEqual({ started: false, reason: 'background-service' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('skips autostart when this computer holds no pairing', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      configPath: '/missing-worker-node.json',
      readPairing: unpaired,
      getWorkerMode: () => workerMode,
      startRuntime,
    });

    expect(result).toEqual({ started: false, reason: 'missing-config' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('skips autostart without throwing when the worker config cannot be read', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: () => { throw new SyntaxError('Unexpected end of JSON input'); },
      getWorkerMode: () => workerMode,
      startRuntime,
    });

    expect(result).toEqual({ started: false, reason: 'missing-config' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('reports runtime start failures without throwing', () => {
    const startRuntime = vi.fn(() => {
      throw new Error('worker binary missing');
    });

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: paired,
      getWorkerMode: () => workerMode,
      startRuntime,
    });

    expect(result).toEqual({
      started: false,
      reason: 'start-failed',
      error: 'worker binary missing',
    });
  });
});

describe('bindWorkerModeRoleLifecycle', () => {
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

  it('starts a paired worker when the computer becomes a worker', () => {
    const settings = fakeSettings({ ...workerMode, role: 'coordinator' });
    const startIfPaired = vi.fn(() => ({ started: true }));
    const stopRuntime = vi.fn();
    bindWorkerModeRoleLifecycle({ settings, startIfPaired, stopRuntime });

    settings.change({ ...workerMode, role: 'worker' });

    expect(startIfPaired).toHaveBeenCalledTimes(1);
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('stops the in-app worker when the computer stops being a worker', () => {
    const settings = fakeSettings(workerMode);
    const startIfPaired = vi.fn(() => ({ started: true }));
    const stopRuntime = vi.fn();
    bindWorkerModeRoleLifecycle({ settings, startIfPaired, stopRuntime });

    settings.change({ ...workerMode, role: 'coordinator' });

    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(startIfPaired).not.toHaveBeenCalled();
  });

  it('ignores workerMode writes that keep the same role', () => {
    const settings = fakeSettings(workerMode);
    const startIfPaired = vi.fn(() => ({ started: true }));
    const stopRuntime = vi.fn();
    bindWorkerModeRoleLifecycle({ settings, startIfPaired, stopRuntime });

    settings.change({ ...workerMode, lastCoordinatorName: 'Mac' });
    settings.change({ ...workerMode, startWorkerOnLaunch: false });

    expect(startIfPaired).not.toHaveBeenCalled();
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it('does not stop anything when moving between non-worker roles', () => {
    const settings = fakeSettings({ ...workerMode, role: 'unset' });
    const startIfPaired = vi.fn(() => ({ started: true }));
    const stopRuntime = vi.fn();
    bindWorkerModeRoleLifecycle({ settings, startIfPaired, stopRuntime });

    settings.change({ ...workerMode, role: 'coordinator' });

    expect(stopRuntime).not.toHaveBeenCalled();
  });
});

describe('reconcileStaleWorkerServiceFlag', () => {
  function settingsWith(value: WorkerModeSettings) {
    let current = value;
    return {
      get: () => current,
      set: vi.fn((_key: 'workerMode', next: WorkerModeSettings) => { current = next; }),
    };
  }

  it('restores launch autostart when no service backs the flag', async () => {
    const settings = settingsWith({ ...workerMode, startWorkerOnLaunch: false, installWorkerService: true });

    const cleared = await reconcileStaleWorkerServiceFlag({
      settings,
      isServiceInstalled: async () => false,
    });

    expect(cleared).toBe(true);
    expect(settings.get()).toMatchObject({
      role: 'worker',
      startWorkerOnLaunch: true,
      installWorkerService: false,
    });
  });

  it('leaves a real installed service alone', async () => {
    const settings = settingsWith({ ...workerMode, startWorkerOnLaunch: false, installWorkerService: true });

    expect(await reconcileStaleWorkerServiceFlag({ settings, isServiceInstalled: async () => true })).toBe(false);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('does not check anything when the flag is not set', async () => {
    const settings = settingsWith(workerMode);
    const isServiceInstalled = vi.fn(async () => false);

    expect(await reconcileStaleWorkerServiceFlag({ settings, isServiceInstalled })).toBe(false);
    expect(isServiceInstalled).not.toHaveBeenCalled();
  });

  it('leaves settings alone when the check fails or hangs', async () => {
    const settings = settingsWith({ ...workerMode, installWorkerService: true });

    expect(await reconcileStaleWorkerServiceFlag({
      settings,
      isServiceInstalled: async () => { throw new Error('sc.exe missing'); },
    })).toBe(false);
    expect(await reconcileStaleWorkerServiceFlag({
      settings,
      isServiceInstalled: () => new Promise<boolean>(() => undefined),
      timeoutMs: 10,
    })).toBe(false);
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('Windows sign-in worker', () => {
  function fakeSignInTask(supported = true) {
    return {
      isSupported: () => supported,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      ensureCurrent: vi.fn(async () => true),
    };
  }

  function lifecycleSettings(initial: WorkerModeSettings) {
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

  it('does not start Harness\'s own worker when the sign-in task owns it', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: paired,
      getWorkerMode: () => ({ ...workerMode, runAtSignIn: true }),
      startRuntime,
      signInTaskSupported: true,
    });

    expect(result).toEqual({ started: false, reason: 'sign-in-task' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('ignores the sign-in flag where the task is unsupported', () => {
    const startRuntime = vi.fn(() => ({ state: 'running' as const }));

    const result = maybeStartWorkerModeOnLaunch({
      readPairing: paired,
      getWorkerMode: () => ({ ...workerMode, runAtSignIn: true }),
      startRuntime,
      signInTaskSupported: false,
    });

    expect(result.started).toBe(true);
  });

  it('resumes the task on entering the worker role and pauses it on leaving', () => {
    const settings = lifecycleSettings({ ...workerMode, role: 'coordinator', runAtSignIn: true });
    const signInTask = fakeSignInTask();
    const startIfPaired = vi.fn(() => ({ started: false }));
    const stopRuntime = vi.fn();
    bindWorkerModeRoleLifecycle({ settings, startIfPaired, stopRuntime, signInTask });

    settings.change({ ...workerMode, role: 'worker', runAtSignIn: true });
    expect(signInTask.start).toHaveBeenCalledTimes(1);
    expect(startIfPaired).not.toHaveBeenCalled();

    settings.change({ ...workerMode, role: 'coordinator', runAtSignIn: true });
    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(signInTask.stop).toHaveBeenCalledTimes(1);
  });

  it('survives a task failure during a role change', async () => {
    const settings = lifecycleSettings({ ...workerMode, role: 'coordinator', runAtSignIn: true });
    const signInTask = fakeSignInTask();
    signInTask.start.mockRejectedValueOnce(new Error('Windows task setup failed'));
    bindWorkerModeRoleLifecycle({ settings, startIfPaired: vi.fn(() => ({ started: false })), stopRuntime: vi.fn(), signInTask });

    expect(() => settings.change({ ...workerMode, role: 'worker', runAtSignIn: true })).not.toThrow();
    await Promise.resolve();
  });

  it('updates a paired sign-in worker at launch', async () => {
    const signInTask = fakeSignInTask();

    const updated = await ensureSignInWorkerOnLaunch({
      settings: { get: () => ({ ...workerMode, runAtSignIn: true }) },
      signInTask,
      readPairing: paired,
      configPath: '/worker-node.json',
    });

    expect(updated).toBe(true);
    expect(signInTask.ensureCurrent).toHaveBeenCalledWith('/worker-node.json');
  });

  it('skips launch upkeep when not a paired sign-in worker, and never throws', async () => {
    const signInTask = fakeSignInTask();

    expect(await ensureSignInWorkerOnLaunch({ settings: { get: () => workerMode }, signInTask, readPairing: paired })).toBe(false);
    expect(await ensureSignInWorkerOnLaunch({
      settings: { get: () => ({ ...workerMode, role: 'coordinator', runAtSignIn: true }) },
      signInTask,
      readPairing: paired,
    })).toBe(false);
    expect(await ensureSignInWorkerOnLaunch({
      settings: { get: () => ({ ...workerMode, runAtSignIn: true }) },
      signInTask,
      readPairing: unpaired,
    })).toBe(false);
    expect(signInTask.ensureCurrent).not.toHaveBeenCalled();

    signInTask.ensureCurrent.mockRejectedValueOnce(new Error('powershell missing'));
    await expect(ensureSignInWorkerOnLaunch({
      settings: { get: () => ({ ...workerMode, runAtSignIn: true }) },
      signInTask,
      readPairing: paired,
    })).resolves.toBe(false);
  });
});

