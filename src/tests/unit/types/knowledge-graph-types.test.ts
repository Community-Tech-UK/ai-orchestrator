import { describe, it, expect } from 'vitest';
import type {
  KGEntity,
  KGTriple,
  KGEntityQuery,
  KGRelationshipQuery,
  KGTimelineQuery,
  KGQueryResult,
  KGStats,
  KGDirection,
} from '../../../shared/types/knowledge-graph.types';

describe('knowledge-graph types', () => {
  it('should create a valid entity', () => {
    const entity: KGEntity = {
      id: 'alice',
      name: 'Alice',
      type: 'person',
      properties: { role: 'developer' },
      createdAt: Date.now(),
    };
    expect(entity.id).toBe('alice');
    expect(entity.type).toBe('person');
  });

  it('should create a valid triple with temporal bounds', () => {
    const triple: KGTriple = {
      id: 't_alice_works_at_acme_abc123',
      subject: 'alice',
      predicate: 'works_at',
      object: 'acme_corp',
      validFrom: '2020-01-01',
      validTo: null,
      confidence: 1.0,
      sourceCloset: null,
      sourceFile: null,
      extractedAt: Date.now(),
    };
    expect(triple.validTo).toBeNull();
    expect(triple.confidence).toBe(1.0);
  });

  it('should express query direction types', () => {
    const directions: KGDirection[] = ['outgoing', 'incoming', 'both'];
    expect(directions).toHaveLength(3);
  });

  it('should create entity query with temporal filter', () => {
    const query: KGEntityQuery = {
      entityName: 'Alice',
      asOf: '2024-06-01',
      direction: 'both',
    };
    expect(query.asOf).toBe('2024-06-01');
  });

  it('should create a stats object', () => {
    const stats: KGStats = {
      entities: 10,
      triples: 25,
      currentFacts: 20,
      expiredFacts: 5,
      relationshipTypes: ['works_at', 'child_of', 'loves'],
    };
    expect(stats.currentFacts + stats.expiredFacts).toBe(stats.triples);
  });
});
