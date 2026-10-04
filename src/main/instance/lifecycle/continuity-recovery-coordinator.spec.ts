import { describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceStatus } from '../../../shared/types/instance.types';
import { ContinuityRecoveryCoordinator } from './continuity-recovery-coordinator';

function coordinatorWith(instances: Instance[]): ContinuityRecoveryCoordinator {
  return new ContinuityRecoveryCoordinator({
    createInstance: vi.fn(),
    createUnpublishedInstance: vi.fn(),
    getAllInstances: () => instances,
    queueContinuityPreamble: vi.fn(),
    clearPrivateState: vi.fn(),
  });
}

function instanceWithStatus(status: InstanceStatus): Instance {
  return {
    id: `instance-${status}`,
    status,
    provider: 'codex',
    historyThreadId: `thread-${status}`,
    sessionId: `session-${status}`,
  } as unknown as Instance;
}

describe('ContinuityRecoveryCoordinator live recovery keys', () => {
  it('keeps a hibernated instance live so it is never offered for recovery', () => {
    const keys = coordinatorWith([instanceWithStatus('hibernated')]).getLiveRecoveryKeys();

    expect(keys).toContain('history:codex:thread-hibernated');
    expect(keys).toContain('session:codex:session-hibernated');
  });

  it.each<InstanceStatus>(['terminated', 'failed', 'error', 'cancelled', 'superseded'])(
    'treats a %s instance as not live',
    (status) => {
      expect(coordinatorWith([instanceWithStatus(status)]).getLiveRecoveryKeys().size).toBe(0);
    },
  );
});
