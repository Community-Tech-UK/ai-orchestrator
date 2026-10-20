import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-worker-mode-autostart-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

const calls = vi.hoisted(() => [] as string[]);
const autostart = vi.hoisted(() => ({
  reconcileStaleWorkerServiceFlag: vi.fn(),
  maybeStartWorkerModeOnLaunch: vi.fn(),
  bindWorkerModeRoleLifecycle: vi.fn(),
  ensureSignInWorkerOnLaunch: vi.fn(),
}));
const loginItem = vi.hoisted(() => ({ bindWorkerModeLoginItem: vi.fn() }));

vi.mock('../remote-node/worker-mode-autostart', () => autostart);
vi.mock('../remote-node/worker-mode-login-item', () => loginItem);

import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { createInitializationSteps } from './initialization-steps';

function findWorkerModeStep() {
  const step = createInitializationSteps({
    instanceManager: {} as InstanceManager,
    windowManager: {} as WindowManager,
    isStatelessExecProvider: () => false,
    getNodeLatencyForInstance: () => undefined,
    syncRemoteNodeMetricsToLoadBalancer: () => undefined,
  }).find((candidate) => candidate.name === 'Worker mode autostart');
  if (!step) {
    throw new Error('Worker mode autostart step is not registered');
  }
  return step;
}

describe('Worker mode autostart initialization step', () => {
  beforeEach(() => {
    calls.length = 0;
    autostart.reconcileStaleWorkerServiceFlag.mockReset().mockImplementation(async () => { calls.push('reconcile'); });
    autostart.maybeStartWorkerModeOnLaunch.mockReset().mockImplementation(() => { calls.push('maybe-start'); });
    autostart.bindWorkerModeRoleLifecycle.mockReset().mockImplementation(() => { calls.push('bind-role'); });
    loginItem.bindWorkerModeLoginItem.mockReset().mockImplementation(() => { calls.push('bind-login-item'); });
    autostart.ensureSignInWorkerOnLaunch.mockReset().mockImplementation(async () => { calls.push('ensure-sign-in'); return true; });
  });

  it('is registered and runs reconcile, role binding, login-item binding and sign-in worker setup', async () => {
    const step = findWorkerModeStep();

    await step.fn();

    expect(autostart.reconcileStaleWorkerServiceFlag).toHaveBeenCalledOnce();
    expect(autostart.maybeStartWorkerModeOnLaunch).toHaveBeenCalledOnce();
    expect(autostart.bindWorkerModeRoleLifecycle).toHaveBeenCalledOnce();
    expect(loginItem.bindWorkerModeLoginItem).toHaveBeenCalledOnce();
    expect(autostart.ensureSignInWorkerOnLaunch).toHaveBeenCalledOnce();
    expect(calls).toEqual(['reconcile', 'maybe-start', 'bind-role', 'bind-login-item', 'ensure-sign-in']);
  });

  it('does not wait for the sign-in worker check to finish', async () => {
    autostart.ensureSignInWorkerOnLaunch.mockReturnValue(new Promise<boolean>(() => undefined));

    await expect(findWorkerModeStep().fn()).resolves.toBeUndefined();

    expect(autostart.ensureSignInWorkerOnLaunch).toHaveBeenCalledOnce();
  });
});
