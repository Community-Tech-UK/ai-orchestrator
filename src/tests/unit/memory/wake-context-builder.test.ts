import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Expose the in-memory db instance so we can close it between tests
let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';

describe('WakeContextBuilder', () => {
  beforeEach(() => {
    WakeContextBuilder._resetForTesting();
    // Reset the DB between tests to avoid state leakage
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  it('should be a singleton', () => {
    const a = WakeContextBuilder.getInstance();
    const b = WakeContextBuilder.getInstance();
    expect(a).toBe(b);
  });

  describe('L0 — Identity', () => {
    it('should generate default L0 when no identity is set', () => {
      const builder = WakeContextBuilder.getInstance();
      const ctx = builder.generateWakeContext();

      expect(ctx.identity.level).toBe('L0');
      expect(ctx.identity.content).toContain('AI orchestrator');
      expect(ctx.identity.tokenEstimate).toBeLessThanOrEqual(100);
    });

    it('should use custom identity text', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.setIdentity('I am Atlas, a personal AI assistant for Alice.');

      const ctx = builder.generateWakeContext();
      expect(ctx.identity.content).toContain('Atlas');
    });
  });

  describe('L1 — Essential Story', () => {
    it('should generate empty L1 when no hints exist', () => {
      const builder = WakeContextBuilder.getInstance();
      const ctx = builder.generateWakeContext();

      expect(ctx.essentialStory.level).toBe('L1');
      expect(ctx.essentialStory.tokenEstimate).toBeLessThanOrEqual(800);
    });

    it('should include top-importance hints in L1', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('User prefers TypeScript over Python', { importance: 8, room: 'preferences' });
      builder.addHint('Backend uses event-driven architecture', { importance: 7, room: 'architecture' });
      builder.addHint('Deploy via GitHub Actions', { importance: 3, room: 'devops' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('TypeScript');
      expect(ctx.essentialStory.content).toContain('event-driven');
    });

    it('should group hints by room', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Fact A', { importance: 5, room: 'backend' });
      builder.addHint('Fact B', { importance: 5, room: 'backend' });
      builder.addHint('Fact C', { importance: 5, room: 'frontend' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('[backend]');
      expect(ctx.essentialStory.content).toContain('[frontend]');
    });

    it('should respect token budget', () => {
      const builder = WakeContextBuilder.getInstance();
      // Add many hints
      for (let i = 0; i < 50; i++) {
        builder.addHint(`Hint number ${i} with some extra content to fill space`, {
          importance: 10 - (i % 10),
          room: `room_${i % 5}`,
        });
      }

      const ctx = builder.generateWakeContext();
      // L1 should stay within budget (~800 tokens ≈ 3200 chars)
      expect(ctx.essentialStory.content.length).toBeLessThanOrEqual(3500);
    });
  });

  describe('combined wake-up', () => {
    it('should produce L0 + L1 with total token count', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.setIdentity('I am a helpful assistant.');
      builder.addHint('Key fact', { importance: 9, room: 'general' });

      const ctx = builder.generateWakeContext();
      expect(ctx.totalTokens).toBe(ctx.identity.tokenEstimate + ctx.essentialStory.tokenEstimate);
      expect(ctx.totalTokens).toBeLessThanOrEqual(900);
    });

    it('should filter by wing when specified', () => {
      const builder = WakeContextBuilder.getInstance();
      const ctx = builder.generateWakeContext('project_a');
      expect(ctx.wing).toBe('project_a');
    });
  });

  describe('hint management', () => {
    it('should track usage count', () => {
      const builder = WakeContextBuilder.getInstance();
      const hintId = builder.addHint('Important fact', { importance: 8, room: 'general' });

      // Invalidate cache so next generateWakeContext actually regenerates
      builder.configure({ regenerateIntervalMs: 0 });
      builder.generateWakeContext(); // Uses the hint
      builder.generateWakeContext(); // Uses it again

      const hint = builder.getHint(hintId);
      expect(hint).toBeDefined();
      expect(hint!.usageCount).toBe(2);
    });

    it('should remove hints', () => {
      const builder = WakeContextBuilder.getInstance();
      const hintId = builder.addHint('Temp fact', { importance: 5, room: 'general' });

      builder.removeHint(hintId);
      expect(builder.getHint(hintId)).toBeUndefined();
    });
  });

  describe('wing filtering', () => {
    it('should filter hints by room when wing is provided', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('React is great', { importance: 8, room: 'frontend-project' });
      builder.addHint('Rust is fast', { importance: 8, room: 'backend-project' });
      builder.addHint('General tip', { importance: 8, room: 'general' });

      const ctx = builder.generateWakeContext('frontend-project');
      expect(ctx.essentialStory.content).toContain('React is great');
      expect(ctx.essentialStory.content).toContain('General tip');
      expect(ctx.essentialStory.content).not.toContain('Rust is fast');
    });

    it('should return all hints when no wing is provided', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Hint A', { importance: 8, room: 'project-a' });
      builder.addHint('Hint B', { importance: 8, room: 'project-b' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('Hint A');
      expect(ctx.essentialStory.content).toContain('Hint B');
    });

    it('should cache separately for different wings', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Only in alpha', { importance: 9, room: 'alpha' });
      builder.addHint('Only in beta', { importance: 9, room: 'beta' });

      const ctxAlpha = builder.generateWakeContext('alpha');
      const ctxBeta = builder.generateWakeContext('beta');

      expect(ctxAlpha.essentialStory.content).toContain('Only in alpha');
      expect(ctxAlpha.essentialStory.content).not.toContain('Only in beta');
      expect(ctxBeta.essentialStory.content).toContain('Only in beta');
      expect(ctxBeta.essentialStory.content).not.toContain('Only in alpha');
    });
  });
});
