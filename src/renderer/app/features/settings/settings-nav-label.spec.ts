import { describe, expect, it } from 'vitest';
import { navItemLabel } from './settings-nav-label';

describe('Settings navigation name', () => {
  it('keeps the label intact and appends the visible status with badge precedence', () => {
    expect(navItemLabel('General', null, false)).toBe('General');
    expect(navItemLabel('Provider Quota', 'Exhausted', false)).toBe('Provider Quota, Exhausted');
    expect(navItemLabel('Display', null, true)).toBe('Display, Recommended');
    expect(navItemLabel('Display', '2 issues', true)).toBe('Display, 2 issues');
  });
});
