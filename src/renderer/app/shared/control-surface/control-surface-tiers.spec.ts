import { describe, expect, it } from 'vitest';
import { CONTROL_SURFACES } from './control-surface.registry';
import { EVERYDAY_SURFACE_IDS } from './control-surface-tiers';

describe('control surface tiers', () => {
  it('keeps 20 existing everyday destinations', () => {
    expect(EVERYDAY_SURFACE_IDS.size).toBe(20);
    for (const id of EVERYDAY_SURFACE_IDS) expect(CONTROL_SURFACES.some(s => s.id === id)).toBe(true);
  });
  it('tags every surface with the tier the registry lists it under', () => {
    expect(CONTROL_SURFACES.every(s => s.tier === (EVERYDAY_SURFACE_IDS.has(s.id) ? 'everyday' : 'more'))).toBe(true);
  });
});
