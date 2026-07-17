import { describe, expect, it } from 'vitest';
import { admitToTier, filterMemoriesForTier } from './memory-instruction-gate';

describe('admitToTier', () => {
  it('advisory tier always admits regardless of provenance or gate', () => {
    expect(admitToTier('agent-derived', 'advisory', true)).toBe(true);
    expect(admitToTier('agent-derived', 'advisory', false)).toBe(true);
  });

  it('system tier blocks agent-derived when the gate is enabled', () => {
    expect(admitToTier('agent-derived', 'system', true)).toBe(false);
    expect(admitToTier('user-authored', 'system', true)).toBe(true);
    expect(admitToTier('imported', 'system', true)).toBe(true);
  });

  it('system tier admits everything when the operator disables the gate', () => {
    expect(admitToTier('agent-derived', 'system', false)).toBe(true);
  });
});

describe('filterMemoriesForTier', () => {
  const memories = [
    { id: 'm1', provenance: 'agent-derived' as const },
    { id: 'm2', provenance: 'user-authored' as const },
    { id: 'm3', provenance: 'imported' as const },
  ];

  it('agent-derived memories never reach system-tier assembly (gate on)', () => {
    const { admitted, blocked } = filterMemoriesForTier(memories, 'system', true);
    expect(admitted.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(blocked).toEqual(['m1']);
  });

  it('advisory tier keeps all memories', () => {
    const { admitted, blocked } = filterMemoriesForTier(memories, 'advisory', true);
    expect(admitted).toHaveLength(3);
    expect(blocked).toEqual([]);
  });
});
