import { describe, expect, it } from 'vitest';
import { ALL_INSTANCE_STATUSES, attentionLevelForInstanceStatus } from '../../shared/attention/attention-level';
import type { Instance } from '../../shared/types/instance.types';
import { WAITING_STATUSES, WORKING_STATUSES, buildProjects, serializeInstance } from './mobile-gateway-serializers';

function inst(partial: Partial<Instance>): Instance {
  return {
    id: 'i1',
    displayName: 'Agent',
    status: 'idle',
    provider: 'claude',
    workingDirectory: '/repo/alpha',
    createdAt: 1,
    lastActivity: 1,
    parentId: null,
    contextUsage: { used: 0, total: 0, percentage: 0 },
    outputBuffer: [],
    ...partial,
  } as unknown as Instance;
}

describe('mobile-gateway-serializers WS-C2 attention scale', () => {
  it('WORKING_STATUSES / WAITING_STATUSES are single-sourced from the shared scale (no drift)', () => {
    const expectedWorking = ALL_INSTANCE_STATUSES.filter(
      (status) => attentionLevelForInstanceStatus(status) === 'working',
    );
    const expectedBlocked = ALL_INSTANCE_STATUSES.filter(
      (status) => attentionLevelForInstanceStatus(status) === 'blocked',
    );
    expect([...WORKING_STATUSES].sort()).toEqual([...expectedWorking].sort());
    expect([...WAITING_STATUSES].sort()).toEqual([...expectedBlocked].sort());
    // Pinned exact set so a silent widening/narrowing of either bucket is caught here.
    expect([...WAITING_STATUSES].sort()).toEqual(['waiting_for_input', 'waiting_for_permission']);
  });

  it('serializeInstance carries the same attentionLevel Workboard would compute for this status', () => {
    expect(serializeInstance(inst({ status: 'waiting_for_permission' })).attentionLevel).toBe('blocked');
    expect(serializeInstance(inst({ status: 'error' })).attentionLevel).toBe('failed');
    expect(serializeInstance(inst({ status: 'degraded' })).attentionLevel).toBe('failed');
    expect(serializeInstance(inst({ status: 'failed' })).attentionLevel).toBe('failed');
    expect(serializeInstance(inst({ status: 'busy' })).attentionLevel).toBe('working');
    expect(serializeInstance(inst({ status: 'idle' })).attentionLevel).toBe('idle');
    expect(serializeInstance(inst({ status: 'hibernating' })).attentionLevel).toBe('waiting');
  });

  it('the pendingApprovalCount fallback stays narrow to an answerable prompt (blocked only)', () => {
    // Before WS-C2's attentionLevel field, `degraded`/`error`/`failed` had NO
    // gateway-computed "needs you" signal at all. `pendingApprovalCount`
    // specifically means "how many things can I approve right now", so it
    // correctly stays 0 for a failure with nothing to approve — the closed
    // gap is `attentionLevel` / `needsAttentionCount`, not this field.
    expect(serializeInstance(inst({ status: 'waiting_for_permission' })).pendingApprovalCount).toBe(1);
    expect(serializeInstance(inst({ status: 'error' })).pendingApprovalCount).toBe(0);
    expect(serializeInstance(inst({ status: 'degraded' })).pendingApprovalCount).toBe(0);
    expect(serializeInstance(inst({ status: 'failed' })).pendingApprovalCount).toBe(0);
  });

  describe('buildProjects needsAttentionCount (WS-C2 numeric gap fix)', () => {
    it('counts a failed/degraded/error instance — previously invisible to any mobile rollup', () => {
      const projects = buildProjects([
        serializeInstance(inst({ id: 'a', status: 'error', workingDirectory: '/repo/proj' })),
        serializeInstance(inst({ id: 'b', status: 'degraded', workingDirectory: '/repo/proj' })),
        serializeInstance(inst({ id: 'c', status: 'failed', workingDirectory: '/repo/proj' })),
      ]);
      expect(projects[0]?.needsAttentionCount).toBe(3);
      // The pre-existing narrower field stays 0 for all three — nothing to approve.
      expect(projects[0]?.pendingApprovalCount).toBe(0);
    });

    it('counts a blocked (waiting_for_permission/input) instance', () => {
      const projects = buildProjects([
        serializeInstance(inst({ id: 'a', status: 'waiting_for_input', workingDirectory: '/repo/proj' })),
      ]);
      expect(projects[0]?.needsAttentionCount).toBe(1);
      expect(projects[0]?.pendingApprovalCount).toBe(1);
    });

    it('does not count working, waiting, or idle instances', () => {
      const projects = buildProjects([
        serializeInstance(inst({ id: 'a', status: 'busy', workingDirectory: '/repo/proj' })),
        serializeInstance(inst({ id: 'b', status: 'hibernating', workingDirectory: '/repo/proj' })),
        serializeInstance(inst({ id: 'c', status: 'idle', workingDirectory: '/repo/proj' })),
      ]);
      expect(projects[0]?.needsAttentionCount).toBe(0);
    });
  });
});

/**
 * LT-018 on the mobile surface. `MobileInstanceDto.contextPercentage` is
 * documented as "0–100 context window usage, **when known**", and omitting it is
 * how the phone client is told there is nothing to show. Because
 * `Instance.contextUsage` is seeded at create, sending it unconditionally
 * shipped a confident `0` for every session that had not reported yet — the same
 * defect that was fixed across four desktop surfaces.
 */
describe('serializeInstance contextPercentage (LT-018)', () => {
  it('omits contextPercentage when the provider has not reported occupancy', () => {
    const dto = serializeInstance(
      inst({ contextUsage: { used: 0, total: 200_000, percentage: 0 } }),
    );

    expect(dto.contextPercentage).toBeUndefined();
    expect('contextPercentage' in dto ? dto.contextPercentage : undefined).toBeUndefined();
  });

  it('sends the real percentage once the provider reports', () => {
    const dto = serializeInstance(
      inst({
        contextUsage: {
          used: 50_000, total: 200_000, percentage: 25, occupancyReported: true,
        },
      }),
    );

    expect(dto.contextPercentage).toBe(25);
  });

  it('sends a genuine 0%, because that is a measurement and not an absence', () => {
    const dto = serializeInstance(
      inst({
        contextUsage: { used: 0, total: 200_000, percentage: 0, occupancyReported: true },
      }),
    );

    expect(dto.contextPercentage).toBe(0);
  });
});
