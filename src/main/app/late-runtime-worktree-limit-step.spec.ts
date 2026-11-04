import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronHarness = vi.hoisted(() => {
  // require(+.ts) avoids ESM TDZ: vi.hoisted runs before import bindings initialize
  const { createElectronHarness } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before imports initialize, so a static import would hit the TDZ
    require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
  return createElectronHarness();
});
vi.mock('electron', () => electronHarness.module);

const settings = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.hoisted runs before imports initialize
  const { EventEmitter: Emitter } = require('events') as typeof import('events');
  const values: Record<string, unknown> = { maxConcurrentWorktrees: 7 };
  return Object.assign(new Emitter(), { values, get: (key: string) => values[key] });
});
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => settings }));
const schedulable = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../automations', () => ({ getAutomationStore: () => ({ listSchedulable: () => schedulable.list }) }));

import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { getWorktreeManager, _resetWorktreeManagerForTesting } from '../workspace/git/worktree-manager';
import { createLateRuntimeInitializationSteps, scheduledLoopResumes } from './late-runtime-initialization-steps';

function steps() {
  return createLateRuntimeInitializationSteps({
    instanceManager: {} as InstanceManager,
    windowManager: {} as WindowManager,
    isStatelessExecProvider: () => false,
    getNodeLatencyForInstance: () => undefined,
    syncRemoteNodeMetricsToLoadBalancer: () => undefined,
  });
}

describe('late runtime Worktree limit step', () => {
  afterEach(() => {
    (settings as EventEmitter).removeAllListeners();
    _resetWorktreeManagerForTesting();
  });

  it('runs before anything that recovers worktrees', () => {
    const names = steps().map((step) => step.name);
    const limit = names.indexOf('Worktree limit');
    expect(limit).toBeGreaterThanOrEqual(0);
    expect(limit).toBeLessThan(names.indexOf('Loop store'));
    expect(limit).toBeLessThan(names.indexOf('Campaign coordinator'));
    expect(limit).toBeLessThan(names.indexOf('Plan queue coordinator'));
  });

  it('applies the saved setting and follows later changes without a restart', async () => {
    await steps().find((step) => step.name === 'Worktree limit')!.fn();
    expect(getWorktreeManager().getConfig().maxConcurrent).toBe(7);

    (settings as EventEmitter).emit('setting:maxConcurrentWorktrees', 0);
    expect(getWorktreeManager().getConfig().maxConcurrent).toBe(0);
  });
});

describe('scheduledLoopResumes', () => {
  it('lists only loops a pending automation will resume', () => {
    schedulable.list = [
      { action: { systemAction: { type: 'loopProviderLimitResume', loopRunId: 'loop-monthly' } } },
      { action: { systemAction: { type: 'instanceProviderLimitResume', instanceId: 'chat-1' } } },
      { action: {} },
    ];
    expect([...scheduledLoopResumes()]).toEqual(['loop-monthly']);
  });
});
