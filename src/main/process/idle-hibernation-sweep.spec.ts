import { describe, it, expect, vi, beforeEach } from 'vitest';

const electronHarness = vi.hoisted(() => {
  // require(+.ts) avoids ESM TDZ: vi.hoisted runs before import bindings initialize
  const { createElectronHarness } =
    require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
  return createElectronHarness({ powerMonitor: 'stub' });
});
vi.mock('electron', () => electronHarness.module);

const inhibited = vi.hoisted(() => new Set<string>());
vi.mock('../instance/instance-async-work-registry', () => ({
  getInstanceAsyncWorkRegistry: () => ({
    hasInhibitor: (instanceId: string) => inhibited.has(instanceId),
  }),
}));

import { HibernationManager } from './hibernation-manager';
import {
  _resetAdapterLoansForTesting,
  beginAdapterLoan,
} from '../instance/lifecycle/adapter-loan-registry';
import { runIdleHibernationSweep, type IdleSweepInstance } from './idle-hibernation-sweep';

const MINUTE = 60_000;
// Anchored to the real clock: HibernationManager stamps wake cooldowns with
// Date.now(), so a synthetic "now" far from it would make every cooldown look expired.
const NOW = Date.now();

function instance(overrides: Partial<IdleSweepInstance> & { id: string }): IdleSweepInstance {
  return {
    status: 'idle',
    parentId: null,
    isRemote: false,
    lastActivity: NOW - 45 * MINUTE,
    ...overrides,
  };
}

describe('runIdleHibernationSweep', () => {
  let hibernation: HibernationManager;
  let hibernateInstance: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

  const sweep = (instances: IdleSweepInstance[], idleMinutes = 30) =>
    runIdleHibernationSweep({
      hibernation,
      getInstances: () => instances,
      getIdleMinutes: () => idleMinutes,
      hibernateInstance,
      now: () => NOW,
    });

  beforeEach(() => {
    inhibited.clear();
    _resetAdapterLoansForTesting();
    hibernation = new HibernationManager();
    hibernateInstance = vi.fn(async () => undefined);
  });

  it('hibernates a root session idle past the threshold', () => {
    sweep([instance({ id: 'root-1' })]);

    expect(hibernateInstance).toHaveBeenCalledWith('root-1');
  });

  it('leaves a root session alone while it is inside the threshold', () => {
    sweep([instance({ id: 'root-1', lastActivity: NOW - 10 * MINUTE })]);

    expect(hibernateInstance).not.toHaveBeenCalled();
  });

  it('never touches a session that is not idle', () => {
    sweep([
      instance({ id: 'busy', status: 'busy', lastActivity: NOW - 3 * 60 * MINUTE }),
      instance({ id: 'ready', status: 'ready', lastActivity: NOW - 3 * 60 * MINUTE }),
    ]);

    expect(hibernateInstance).not.toHaveBeenCalled();
  });

  it('leaves child instances to the IdleMonitor', () => {
    sweep([instance({ id: 'child-1', parentId: 'root-1' })]);

    expect(hibernateInstance).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is 0, even after a previous non-zero sync', () => {
    sweep([instance({ id: 'root-1', lastActivity: NOW - 50 * MINUTE })], 45);
    expect(hibernation.getConfig().idleThresholdMs).toBe(45 * MINUTE);
    expect(hibernateInstance).toHaveBeenCalledTimes(1);

    sweep([instance({ id: 'root-2', lastActivity: NOW - 3 * 60 * MINUTE })], 0);
    expect(hibernateInstance).toHaveBeenCalledTimes(1);
    expect(hibernateInstance).not.toHaveBeenCalledWith('root-2');
  });

  it('syncs the manager threshold from the setting', () => {
    sweep([instance({ id: 'root-1', lastActivity: NOW - 45 * MINUTE })], 60);

    expect(hibernation.getConfig().idleThresholdMs).toBe(60 * MINUTE);
    expect(hibernateInstance).not.toHaveBeenCalled();

    sweep([instance({ id: 'root-1', lastActivity: NOW - 61 * MINUTE })], 60);
    expect(hibernateInstance).toHaveBeenCalledWith('root-1');
  });

  it('skips a session whose adapter is on loan to a same-session loop (LT-020)', () => {
    beginAdapterLoan('root-1', 'loop-run-1');

    sweep([instance({ id: 'root-1' }), instance({ id: 'root-2' })]);

    expect(hibernateInstance).toHaveBeenCalledTimes(1);
    expect(hibernateInstance).toHaveBeenCalledWith('root-2');
  });

  it('skips the chat instance of a loop that has not ended (e.g. parked on a provider limit)', () => {
    runIdleHibernationSweep({
      hibernation,
      getInstances: () => [instance({ id: 'loop-chat' }), instance({ id: 'plain-root' })],
      getIdleMinutes: () => 30,
      hibernateInstance,
      hasLiveLoop: (id) => id === 'loop-chat',
      now: () => NOW,
    });

    expect(hibernateInstance).toHaveBeenCalledTimes(1);
    expect(hibernateInstance).toHaveBeenCalledWith('plain-root');
  });

  it('skips remote worker-node sessions', () => {
    sweep([instance({ id: 'remote-1', isRemote: true }), instance({ id: 'local-1' })]);

    expect(hibernateInstance).toHaveBeenCalledTimes(1);
    expect(hibernateInstance).toHaveBeenCalledWith('local-1');
  });

  it('does not re-hibernate a session inside the wake cooldown', () => {
    hibernation.markHibernated('root-1', {
      instanceId: 'root-1',
      displayName: 'Root',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: NOW - 2 * 60 * MINUTE,
    });
    hibernation.markAwoken('root-1');

    sweep([instance({ id: 'root-1' })]);

    expect(hibernateInstance).not.toHaveBeenCalled();
  });

  it('skips a session with in-flight async work', () => {
    inhibited.add('root-1');

    sweep([instance({ id: 'root-1' }), instance({ id: 'root-2' })]);

    expect(hibernateInstance).toHaveBeenCalledTimes(1);
    expect(hibernateInstance).toHaveBeenCalledWith('root-2');
  });

  it('skips a session the manager already tracks as hibernated', () => {
    hibernation.markHibernated('root-1', {
      instanceId: 'root-1',
      displayName: 'Root',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: NOW - 60 * MINUTE,
    });

    sweep([instance({ id: 'root-1' })]);

    expect(hibernateInstance).not.toHaveBeenCalled();
  });

  it('logs and continues when a hibernate rejects', async () => {
    hibernateInstance.mockRejectedValueOnce(new Error('boom'));

    sweep([instance({ id: 'root-1' }), instance({ id: 'root-2' })]);
    await vi.waitFor(() => expect(hibernateInstance).toHaveBeenCalledTimes(2));

    expect(hibernateInstance).toHaveBeenCalledWith('root-1');
    expect(hibernateInstance).toHaveBeenCalledWith('root-2');
  });
});
