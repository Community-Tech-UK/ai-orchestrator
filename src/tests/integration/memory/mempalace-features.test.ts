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

import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { ConversationMiner } from '../../../main/memory/conversation-miner';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';
import { KnowledgeBridge } from '../../../main/memory/knowledge-bridge';
import type { Reflection } from '../../../main/observation/observation.types';

describe('mempalace-inspired features — integration', () => {
  beforeEach(() => {
    KnowledgeGraphService._resetForTesting();
    ConversationMiner._resetForTesting();
    WakeContextBuilder._resetForTesting();
    KnowledgeBridge._resetForTesting();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  it('should mine a conversation, extract knowledge, and generate wake-up context', () => {
    // 1. Import a conversation
    const miner = ConversationMiner.getInstance();
    const conversation = `> What database should we use?
We decided to use PostgreSQL for its JSON support and reliability.

> How should we handle authentication?
JWT tokens with refresh rotation. Store in httpOnly cookies. Never in localStorage.

> What about the deploy pipeline?
GitHub Actions with staging → production promotion. Blue-green deploys.`;

    const result = miner.importFromString(conversation, {
      wing: 'my_project',
      sourceFile: '/conversations/planning.txt',
    });
    expect(result.segmentsCreated).toBeGreaterThan(0);

    // 2. Record knowledge from the conversation
    const kg = KnowledgeGraphService.getInstance();
    kg.addFact('my_project', 'uses_database', 'PostgreSQL');
    kg.addFact('my_project', 'auth_strategy', 'JWT with refresh rotation');
    kg.addFact('my_project', 'deploy_strategy', 'Blue-green via GitHub Actions');

    const facts = kg.queryEntity('my_project');
    expect(facts).toHaveLength(3);

    // 3. Build wake-up context from the knowledge
    const wake = WakeContextBuilder.getInstance();
    wake.setIdentity('Assistant for my_project — a web application.');
    wake.addHint('Database: PostgreSQL (chosen for JSON support)', { importance: 8, room: 'architecture' });
    wake.addHint('Auth: JWT + httpOnly cookies (never localStorage)', { importance: 9, room: 'security' });
    wake.addHint('Deploy: Blue-green via GitHub Actions', { importance: 7, room: 'devops' });

    const ctx = wake.generateWakeContext();
    expect(ctx.totalTokens).toBeLessThanOrEqual(900);
    expect(ctx.identity.content).toContain('my_project');
    expect(ctx.essentialStory.content).toContain('PostgreSQL');
    expect(ctx.essentialStory.content).toContain('JWT');

    // 4. Get injectable text
    const text = wake.getWakeUpText();
    expect(text).toContain('my_project');
    expect(text).toContain('[architecture]');
    expect(text).toContain('[security]');
  });

  it('should handle temporal knowledge graph queries', () => {
    const kg = KnowledgeGraphService.getInstance();

    // Alice worked at Acme 2020-2024, then NewCo 2025+
    kg.addFact('Alice', 'works_at', 'Acme', { validFrom: '2020-01-01' });
    kg.invalidateFact('Alice', 'works_at', 'Acme', '2024-06-01');
    kg.addFact('Alice', 'works_at', 'NewCo', { validFrom: '2024-07-01' });

    // Max does chess since 2024, swimming since 2025
    kg.addFact('Max', 'does', 'Chess', { validFrom: '2024-06-01' });
    kg.addFact('Max', 'does', 'Swimming', { validFrom: '2025-01-01' });
    kg.addFact('Max', 'child_of', 'Alice');

    // Temporal query: where did Alice work in 2023?
    const in2023 = kg.queryEntity('Alice', { asOf: '2023-01-01' });
    expect(in2023.find(f => f.predicate === 'works_at')?.object).toBe('Acme');

    // Temporal query: where does Alice work in 2025?
    const in2025 = kg.queryEntity('Alice', { asOf: '2025-01-01' });
    expect(in2025.find(f => f.predicate === 'works_at')?.object).toBe('NewCo');

    // Timeline for Max
    const tl = kg.getTimeline('Max');
    expect(tl.length).toBeGreaterThanOrEqual(2);

    // Stats
    const stats = kg.getStats();
    expect(stats.entities).toBeGreaterThanOrEqual(5); // Alice, Acme, NewCo, Max, Chess, Swimming
    expect(stats.expiredFacts).toBe(1); // Alice@Acme
  });

  it('should detect all supported conversation formats', () => {
    expect(ConversationMiner.detectFormat('> Q1\nA1\n\n> Q2\nA2\n\n> Q3\nA3')).toBe('plain-text');
    expect(ConversationMiner.detectFormat('{"type":"human","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":"hello"}}')).toBe('claude-code-jsonl');
    expect(ConversationMiner.detectFormat('{"type":"session_meta","payload":{}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}')).toBe('codex-jsonl');
  });

  it('should bridge promoted reflections into wake hints', () => {
    const bridge = KnowledgeBridge.getInstance();
    const wake = WakeContextBuilder.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_1',
      title: 'TDD is effective',
      insight: 'Test-driven development catches bugs early and reduces rework',
      observationIds: ['obs_i1', 'obs_i2'],
      patterns: [{
        type: 'success_pattern',
        description: 'TDD reduced bug count by 50%',
        evidence: ['3 sessions used TDD with fewer failures'],
        strength: 0.85,
      }],
      confidence: 0.8,
      applicability: ['testing', 'workflow'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 5,
      effectivenessScore: 0.9,
      promotedToProcedural: true,
    };

    // Simulate promotion
    bridge.onPromotedToProcedural(reflection);

    // Should appear in wake context
    const ctx = wake.generateWakeContext();
    expect(ctx.essentialStory.content).toContain('TDD is effective');
  });

  it('should extract KG facts from reflections with sufficient confidence', () => {
    const bridge = KnowledgeBridge.getInstance();
    const kg = KnowledgeGraphService.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_2',
      title: 'async error handling',
      insight: 'Always wrap async calls in try-catch',
      observationIds: ['obs_i3'],
      patterns: [{
        type: 'success_pattern',
        description: 'Proper error handling prevented crashes',
        evidence: ['Handled 5 async errors gracefully'],
        strength: 0.7,
      }],
      confidence: 0.65,
      applicability: ['error_handling'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 0,
      effectivenessScore: 0,
      promotedToProcedural: false,
    };

    bridge.onReflectionCreated(reflection);

    const stats = kg.getStats();
    expect(stats.triples).toBeGreaterThanOrEqual(1);
  });

  it('should NOT extract facts from low-confidence reflections', () => {
    const bridge = KnowledgeBridge.getInstance();
    const kg = KnowledgeGraphService.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_3',
      title: 'weak observation',
      insight: 'Maybe this is useful',
      observationIds: ['obs_i4'],
      patterns: [{
        type: 'workflow_optimization',
        description: 'Possible optimization',
        evidence: ['Saw it once'],
        strength: 0.3,
      }],
      confidence: 0.3,
      applicability: ['misc'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 0,
      effectivenessScore: 0,
      promotedToProcedural: false,
    };

    bridge.onReflectionCreated(reflection);

    const stats = kg.getStats();
    expect(stats.triples).toBe(0);
  });
});
