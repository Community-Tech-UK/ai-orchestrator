import { describe, expect, it } from 'vitest';
import { CONTROL_SURFACES, listControlNavGroups } from './control-surface.registry';
import { EVERYDAY_SURFACE_IDS, NEVER_MORE_SURFACE_IDS, splitNavGroupsByTier } from './control-surface-tiers';

describe('control surface tiers', () => {
  it('keeps 20 existing everyday destinations and all attention pages visible', () => {
    expect(EVERYDAY_SURFACE_IDS.size).toBe(20);
    for (const id of EVERYDAY_SURFACE_IDS) expect(CONTROL_SURFACES.some(s => s.id === id)).toBe(true);
    for (const id of NEVER_MORE_SURFACE_IDS) expect(EVERYDAY_SURFACE_IDS.has(id)).toBe(true);
  });
  it('partitions every surface without losing or duplicating a destination', () => {
    const tiers = splitNavGroupsByTier(listControlNavGroups(true));
    const all = [...tiers.everyday, ...tiers.more].flatMap(g => g.items);
    // Hidden surfaces have no menu entry, so they are in neither tier.
    const listed = CONTROL_SURFACES.filter(s => s.showInControlNav);
    expect(all.map(s => s.id).sort()).toEqual(listed.map(s => s.id).sort());
    expect(tiers.moreCount).toBe(listed.filter(s => !EVERYDAY_SURFACE_IDS.has(s.id)).length);
    expect(all.every(s => s.tier === (EVERYDAY_SURFACE_IDS.has(s.id) ? 'everyday' : 'more'))).toBe(true);
  });
});
