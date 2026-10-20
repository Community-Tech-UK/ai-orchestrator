import { describe, expect, it } from 'vitest';
import { isProjectRailHiddenSession } from './project-rail-hidden-session';

describe('isProjectRailHiddenSession', () => {
  it('hides explicitly flagged sessions and run_on_node spawns', () => {
    expect(isProjectRailHiddenSession({ hideFromProjectRail: true })).toBe(true);
    expect(isProjectRailHiddenSession({ spawnDepth: 1 })).toBe(true);
    expect(isProjectRailHiddenSession({ spawnDepth: 0 })).toBe(true);
  });

  it('keeps ordinary and automation sessions visible', () => {
    expect(isProjectRailHiddenSession(undefined)).toBe(false);
    expect(isProjectRailHiddenSession({})).toBe(false);
    expect(isProjectRailHiddenSession({ hideFromProjectRail: 'true' })).toBe(false);
    expect(isProjectRailHiddenSession({ automationId: 'auto-1', automationHidden: true })).toBe(false);
  });
});
