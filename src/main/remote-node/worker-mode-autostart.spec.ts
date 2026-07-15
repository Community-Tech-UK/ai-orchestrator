import { describe, expect, it, vi } from 'vitest';
import type { WorkerModeSettings } from '../../shared/types/pair-both.types';
import { maybeStartWorkerModeOnLaunch } from './worker-mode-autostart';

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
      existsSync: () => true,
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
      existsSync: () => true,
      getWorkerMode: () => ({ ...workerMode, role: 'coordinator' }),
      startRuntime,
    });

    expect(result).toEqual({ started: false, reason: 'not-worker-role' });
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('skips autostart when background service owns startup', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      existsSync: () => true,
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

  it('skips autostart when the paired worker config is missing', () => {
    const startRuntime = vi.fn();

    const result = maybeStartWorkerModeOnLaunch({
      configPath: '/missing-worker-node.json',
      existsSync: () => false,
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
      existsSync: () => true,
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
