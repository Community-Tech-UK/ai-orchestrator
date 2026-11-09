import { describe, expect, it } from 'vitest';
import { CONTROL_SURFACES } from './control-surface.registry';
import { hubIdOfUrl, hubOfSurface, navigationHubs } from './navigation-hubs';

describe('navigation hubs', () => {
  it('lists about twelve hubs', () => {
    expect(navigationHubs(true)).toHaveLength(12);
  });

  it('lists every menu page in exactly one hub, so nothing is lost', () => {
    const listed = CONTROL_SURFACES.filter(surface => surface.showInControlNav);
    const inHubs = navigationHubs(true).flatMap(hub => hub.pages.map(page => page.id));
    expect([...inHubs].sort()).toEqual(listed.map(surface => surface.id).sort());
  });

  it('puts every page, hidden ones included, in a hub', () => {
    for (const surface of CONTROL_SURFACES) expect(hubOfSurface(surface.id), surface.id).toBeDefined();
  });

  it('opens each hub on its first page and keeps the page names for the tooltip', () => {
    for (const hub of navigationHubs(true)) {
      expect(hub.path).toBe(hub.pages[0].path);
      expect(hub.summary).toContain(hub.pages[0].label);
    }
    const reviews = navigationHubs(true).find(hub => hub.id === 'reviews');
    expect(reviews?.summary).toBe('Doc Reviews, Code Reviews, Verification, Verification Settings and 2 more');
  });

  it('leaves Observations out until memory is on', () => {
    const memory = (on: boolean) => navigationHubs(on).find(hub => hub.id === 'memory')?.pages.map(page => page.id);
    expect(memory(false)).not.toContain('observations');
    expect(memory(true)).toContain('observations');
    expect(memory(true)).toContain('memory-stats');
  });

  it('keeps the pages that need attention first in their hubs', () => {
    const first = (id: string) => navigationHubs(false).find(hub => hub.id === id)?.pages[0].id;
    expect(first('work')).toBe('workboard');
    expect(first('reviews')).toBe('doc-review');
    expect(first('memory')).toBe('memory-review');
    expect(first('automations')).toBe('automations');
  });

  it('finds the hub of a URL by its longest page path', () => {
    expect(hubIdOfUrl('/memory/stats?x=1')).toBe('memory');
    expect(hubIdOfUrl('/plan-queue')).toBe('work');
    expect(hubIdOfUrl('/compare/split')).toBe('usage');
    expect(hubIdOfUrl('/')).toBeUndefined();
  });
});
