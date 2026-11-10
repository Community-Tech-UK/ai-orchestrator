import { describe, it, expect } from 'vitest';
import type {
  KGEntity,
  KGEntityQuery,
} from '../../../shared/types/knowledge-graph.types';

// Kept while James decides on code that nothing reaches: no other file uses
// KGEntity or KGEntityQuery, so this is the only place `tsc` checks them.
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

  it('should create entity query with temporal filter', () => {
    const query: KGEntityQuery = {
      entityName: 'Alice',
      asOf: '2024-06-01',
      direction: 'both',
    };
    expect(query.asOf).toBe('2024-06-01');
  });
});
