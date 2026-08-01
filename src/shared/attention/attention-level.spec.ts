import { describe, expect, it } from 'vitest';
import type { InstanceStatus } from '@contracts/types/instance-events';
import type { LoopStatus } from '../types/loop.types';
import type { AutomationRunStatus } from '../types/automation.types';
import type { RepoJobStatus } from '../types/repo-job.types';
import {
  ALL_INSTANCE_STATUSES,
  ATTENTION_LEVEL_ORDER,
  attentionLevelForAutomationRunStatus,
  attentionLevelForInstanceStatus,
  attentionLevelForLoopStatus,
  attentionLevelForRepoJobStatus,
  isAtLeastAsUrgent,
  mostUrgentAttentionLevel,
  type AttentionLevel,
} from './attention-level';

describe('attention-level', () => {
  it('orders levels most-urgent first', () => {
    expect(ATTENTION_LEVEL_ORDER).toEqual(['blocked', 'failed', 'review', 'waiting', 'working', 'idle']);
  });

  // Every InstanceStatus → AttentionLevel (mapping table, WS-C2 numeric acceptance).
  const instanceCases: [InstanceStatus, AttentionLevel][] = [
    ['waiting_for_permission', 'blocked'],
    ['waiting_for_input', 'blocked'],
    ['degraded', 'failed'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['initializing', 'working'],
    ['busy', 'working'],
    ['processing', 'working'],
    ['thinking_deeply', 'working'],
    ['respawning', 'working'],
    ['waking', 'working'],
    ['interrupting', 'working'],
    ['cancelling', 'working'],
    ['interrupt-escalating', 'working'],
    ['hibernating', 'waiting'],
    ['hibernated', 'waiting'],
    ['ready', 'idle'],
    ['idle', 'idle'],
    ['terminated', 'idle'],
    ['cancelled', 'idle'],
    ['superseded', 'idle'],
  ];
  it.each(instanceCases)('instance status %s -> %s', (status, expected) => {
    expect(attentionLevelForInstanceStatus(status)).toBe(expected);
  });

  it('covers every InstanceStatus exactly once', () => {
    expect(instanceCases.map(([status]) => status).sort()).toEqual(
      [
        'busy', 'cancelled', 'cancelling', 'degraded', 'error', 'failed', 'hibernated', 'hibernating',
        'idle', 'initializing', 'interrupt-escalating', 'interrupting', 'processing', 'ready', 'respawning',
        'superseded', 'terminated', 'thinking_deeply', 'waiting_for_input', 'waiting_for_permission', 'waking',
      ].sort(),
    );
  });

  it('ALL_INSTANCE_STATUSES matches the InstanceStatus union exactly (no drift)', () => {
    expect([...ALL_INSTANCE_STATUSES].sort()).toEqual(instanceCases.map(([status]) => status).sort());
  });

  // Every LoopStatus → AttentionLevel, including the endedAt-sensitive provider-limit split.
  const loopCases: [LoopStatus, number | null, AttentionLevel][] = [
    ['running', null, 'working'],
    ['paused', null, 'waiting'],
    ['provider-limit', null, 'waiting'],
    ['provider-limit', 1000, 'failed'],
    ['completed-needs-review', null, 'review'],
    ['failed', null, 'failed'],
    ['error', null, 'failed'],
    ['no-progress', null, 'failed'],
    ['cap-reached', null, 'failed'],
    ['cost-exceeded', null, 'failed'],
    ['needs-human-arbitration', null, 'failed'],
    ['reviewer-unreliable', null, 'failed'],
    ['reviewer-unavailable', null, 'failed'],
    ['builder-unreliable', null, 'failed'],
    ['completed', null, 'idle'],
    ['cancelled', null, 'idle'],
  ];
  it.each(loopCases)('loop status %s (endedAt=%s) -> %s', (status, endedAt, expected) => {
    expect(attentionLevelForLoopStatus(status, endedAt)).toBe(expected);
  });

  // Every AutomationRunStatus → AttentionLevel.
  const automationCases: [AutomationRunStatus, AttentionLevel][] = [
    ['running', 'working'],
    ['pending', 'waiting'],
    ['failed', 'failed'],
    ['succeeded', 'idle'],
    ['skipped', 'idle'],
    ['cancelled', 'idle'],
  ];
  it.each(automationCases)('automation run status %s -> %s', (status, expected) => {
    expect(attentionLevelForAutomationRunStatus(status)).toBe(expected);
  });

  // Every RepoJobStatus → AttentionLevel.
  const repoJobCases: [RepoJobStatus, AttentionLevel][] = [
    ['running', 'working'],
    ['queued', 'waiting'],
    ['failed', 'failed'],
    ['completed', 'idle'],
    ['cancelled', 'idle'],
  ];
  it.each(repoJobCases)('repo job status %s -> %s', (status, expected) => {
    expect(attentionLevelForRepoJobStatus(status)).toBe(expected);
  });

  describe('mostUrgentAttentionLevel', () => {
    it('returns idle for an empty list', () => {
      expect(mostUrgentAttentionLevel([])).toBe('idle');
    });

    it('picks the most urgent level across a mixed set', () => {
      expect(mostUrgentAttentionLevel(['idle', 'working', 'blocked', 'waiting'])).toBe('blocked');
      expect(mostUrgentAttentionLevel(['idle', 'working', 'failed', 'waiting'])).toBe('failed');
      expect(mostUrgentAttentionLevel(['review', 'waiting'])).toBe('review');
      expect(mostUrgentAttentionLevel(['idle'])).toBe('idle');
    });
  });

  describe('isAtLeastAsUrgent', () => {
    it('is true when the level ranks higher or equal', () => {
      expect(isAtLeastAsUrgent('blocked', 'failed')).toBe(true);
      expect(isAtLeastAsUrgent('failed', 'failed')).toBe(true);
      expect(isAtLeastAsUrgent('idle', 'blocked')).toBe(false);
    });
  });
});
