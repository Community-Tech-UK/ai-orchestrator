import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HibernationManager } from './hibernation-manager';

describe('HibernationManager', () => {
  let manager: HibernationManager;

  beforeEach(() => {
    HibernationManager._resetForTesting();
    manager = HibernationManager.getInstance();
  });

  it('should initialize with default config', () => {
    expect(manager.getConfig().idleThresholdMs).toBe(10 * 60 * 1000);
    expect(manager.getConfig().enableAutoHibernation).toBe(false);
  });

  it('should track hibernated instances', () => {
    manager.markHibernated('inst-1', {
      instanceId: 'inst-1',
      displayName: 'Test',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: Date.now(),
    });
    expect(manager.isHibernated('inst-1')).toBe(true);
    expect(manager.getHibernatedInstances().length).toBe(1);
  });

  it('should remove hibernated state on wake', () => {
    manager.markHibernated('inst-1', {
      instanceId: 'inst-1',
      displayName: 'Test',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: Date.now(),
    });
    manager.markAwoken('inst-1');
    expect(manager.isHibernated('inst-1')).toBe(false);
  });

  it('should identify idle instances', () => {
    const now = Date.now();
    const instances = [
      { id: 'a', status: 'idle' as const, lastActivity: now - 20 * 60 * 1000 }, // 20min idle
      { id: 'b', status: 'busy' as const, lastActivity: now },                   // active
      { id: 'c', status: 'idle' as const, lastActivity: now - 5 * 60 * 1000 },  // 5min idle
    ];
    const eligible = manager.getHibernationCandidates(instances, now);
    expect(eligible.length).toBe(1); // Only 'a' exceeds default 10min threshold
    expect(eligible[0].id).toBe('a');
  });
});
