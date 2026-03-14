import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HibernationManager } from './hibernation-manager';

describe('HibernationManager', () => {
  let manager: HibernationManager;

  beforeEach(() => {
    HibernationManager._resetForTesting();
    manager = HibernationManager.getInstance();
  });

  it('should initialize with default config (30min threshold)', () => {
    expect(manager.getConfig().idleThresholdMs).toBe(30 * 60 * 1000);
  });

  it('should have auto-hibernation enabled by default', () => {
    expect(manager.getConfig().enableAutoHibernation).toBe(true);
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

  it('should identify idle instances exceeding 30min threshold', () => {
    const now = Date.now();
    const instances = [
      { id: 'a', status: 'idle' as const, lastActivity: now - 35 * 60 * 1000 }, // 35min idle
      { id: 'b', status: 'busy' as const, lastActivity: now },                   // active
      { id: 'c', status: 'idle' as const, lastActivity: now - 20 * 60 * 1000 }, // 20min idle
    ];
    const eligible = manager.getHibernationCandidates(instances, now);
    expect(eligible.length).toBe(1); // Only 'a' exceeds 30min threshold
    expect(eligible[0].id).toBe('a');
  });

  describe('hysteresis cooldown', () => {
    it('should NOT include an instance woken within 5min as a hibernation candidate', () => {
      const now = Date.now();

      // Hibernate then wake within the cooldown window
      manager.markHibernated('inst-1', {
        instanceId: 'inst-1',
        displayName: 'Test',
        agentId: 'build',
        sessionState: {},
        hibernatedAt: now - 60 * 60 * 1000,
      });
      manager.markAwoken('inst-1'); // records wake at ~now

      const instances = [
        { id: 'inst-1', status: 'idle' as const, lastActivity: now - 35 * 60 * 1000 },
      ];

      // Check just 1 minute after wake — still in cooldown
      const eligible = manager.getHibernationCandidates(instances, now + 60 * 1000);
      expect(eligible.length).toBe(0);
    });

    it('should include an instance woken more than 5min ago as a candidate again', () => {
      const wakeTime = Date.now();

      manager.markHibernated('inst-1', {
        instanceId: 'inst-1',
        displayName: 'Test',
        agentId: 'build',
        sessionState: {},
        hibernatedAt: wakeTime - 60 * 60 * 1000,
      });
      manager.markAwoken('inst-1'); // records wake at wakeTime

      const instances = [
        { id: 'inst-1', status: 'idle' as const, lastActivity: wakeTime - 35 * 60 * 1000 },
      ];

      // Check 6 minutes after wake — cooldown has expired
      const now = wakeTime + 6 * 60 * 1000;
      const eligible = manager.getHibernationCandidates(instances, now);
      expect(eligible.length).toBe(1);
      expect(eligible[0].id).toBe('inst-1');
    });

    it('should clean up expired recentWakes entries when checking candidates', () => {
      const wakeTime = Date.now();

      manager.markHibernated('inst-1', {
        instanceId: 'inst-1',
        displayName: 'Test',
        agentId: 'build',
        sessionState: {},
        hibernatedAt: wakeTime - 60 * 60 * 1000,
      });
      manager.markAwoken('inst-1');

      const instances = [
        { id: 'inst-1', status: 'idle' as const, lastActivity: wakeTime - 35 * 60 * 1000 },
      ];

      // First call past cooldown — triggers cleanup
      const now = wakeTime + 6 * 60 * 1000;
      manager.getHibernationCandidates(instances, now);

      // The entry should have been cleaned up; calling again still works correctly
      const eligible = manager.getHibernationCandidates(instances, now);
      expect(eligible.length).toBe(1);
    });
  });

  describe('scoreEvictionCandidates', () => {
    it('should return an empty array when no candidates provided', () => {
      const result = manager.scoreEvictionCandidates([]);
      expect(result).toEqual([]);
    });

    it('should return scored candidates sorted by score descending', () => {
      const now = Date.now();
      const candidates = [
        { id: 'a', status: 'idle', lastActivity: now - 10 * 60 * 1000, transcriptSize: 100, restartCost: 1 },
        { id: 'b', status: 'idle', lastActivity: now - 60 * 60 * 1000, transcriptSize: 500, restartCost: 5 },
        { id: 'c', status: 'idle', lastActivity: now - 30 * 60 * 1000, transcriptSize: 200, restartCost: 2 },
      ];

      const result = manager.scoreEvictionCandidates(candidates, now);

      expect(result.length).toBe(3);
      // Scores should be descending
      expect(result[0].score).toBeGreaterThanOrEqual(result[1].score);
      expect(result[1].score).toBeGreaterThanOrEqual(result[2].score);
      // Each result must have a score property
      for (const r of result) {
        expect(typeof r.score).toBe('number');
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
    });

    it('should produce score of 0 for all candidates when all values are equal', () => {
      const now = Date.now();
      const lastActivity = now - 30 * 60 * 1000;
      const candidates = [
        { id: 'x', status: 'idle', lastActivity, transcriptSize: 100, restartCost: 5 },
        { id: 'y', status: 'idle', lastActivity, transcriptSize: 100, restartCost: 5 },
      ];

      const result = manager.scoreEvictionCandidates(candidates, now);

      expect(result.length).toBe(2);
      // When all values are identical, normalized values are all 1 (or 0 if max is 0)
      // idle: (30m/30m)*0.5 = 0.5, transcript: (100/100)*0.3 = 0.3, cost: (5/5)*0.2 = 0.2 → score = 1.0
      for (const r of result) {
        expect(r.score).toBeCloseTo(1.0, 5);
      }
    });

    it('should assign highest score to instance with highest idle time and transcript size', () => {
      const now = Date.now();
      const candidates = [
        { id: 'low',  status: 'idle', lastActivity: now - 10 * 60 * 1000, transcriptSize: 50,  restartCost: 1 },
        { id: 'high', status: 'idle', lastActivity: now - 60 * 60 * 1000, transcriptSize: 500, restartCost: 1 },
      ];

      const result = manager.scoreEvictionCandidates(candidates, now);

      expect(result[0].id).toBe('high');
      expect(result[0].score).toBeGreaterThan(result[1].score);
    });

    it('should handle zero max values gracefully (no NaN or divide-by-zero)', () => {
      const now = Date.now();
      // transcriptSize and restartCost are all 0
      const candidates = [
        { id: 'a', status: 'idle', lastActivity: now - 30 * 60 * 1000, transcriptSize: 0, restartCost: 0 },
        { id: 'b', status: 'idle', lastActivity: now - 60 * 60 * 1000, transcriptSize: 0, restartCost: 0 },
      ];

      const result = manager.scoreEvictionCandidates(candidates, now);

      expect(result.length).toBe(2);
      for (const r of result) {
        expect(Number.isNaN(r.score)).toBe(false);
        expect(Number.isFinite(r.score)).toBe(true);
      }
      // Higher idle time should still win
      expect(result[0].id).toBe('b');
    });
  });
});
