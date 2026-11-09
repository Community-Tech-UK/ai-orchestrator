import { describe, expect, it } from 'vitest';
import { CONTROL_SURFACES } from './control-surface.registry';
import { EVERYDAY_SURFACE_IDS, NEVER_MORE_SURFACE_IDS } from './control-surface-tiers';

describe('control surface tiers', () => {
  it('keeps 20 existing everyday destinations and all attention pages visible', () => {
    expect(EVERYDAY_SURFACE_IDS.size).toBe(20);
    for (const id of EVERYDAY_SURFACE_IDS) expect(CONTROL_SURFACES.some(s => s.id === id)).toBe(true);
    for (const id of NEVER_MORE_SURFACE_IDS) expect(EVERYDAY_SURFACE_IDS.has(id)).toBe(true);
  });
  it('tags every surface with the tier the registry lists it under', () => {
    expect(CONTROL_SURFACES.every(s => s.tier === (EVERYDAY_SURFACE_IDS.has(s.id) ? 'everyday' : 'more'))).toBe(true);
  });
});
