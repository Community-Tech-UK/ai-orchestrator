import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from './settings-defaults';
import {
  activeProfile,
  diffProfile,
  getSettingsProfile,
  INTERACTIVE_PROFILE,
  isProfileActive,
  OVERNIGHT_PROFILE,
  SETTINGS_PROFILES,
} from './settings-profiles';

describe('settings profiles (S4.1)', () => {
  /**
   * Decision 9 chose profiles precisely so defaults would NOT change for
   * everyone. If shipping this file altered anyone's behaviour it would have
   * defeated its own purpose.
   */
  it('changes nothing for an existing install: Interactive IS today\'s defaults', () => {
    expect(diffProfile(INTERACTIVE_PROFILE, DEFAULT_SETTINGS)).toEqual([]);
    expect(activeProfile(DEFAULT_SETTINGS)).toBe('interactive');
  });

  it('Overnight actually differs from the defaults, or it would be pointless', () => {
    const changes = diffProfile(OVERNIGHT_PROFILE, DEFAULT_SETTINGS);
    expect(changes.length).toBeGreaterThan(0);
    const keys = changes.map((c) => c.key);
    expect(keys).toContain('instanceProviderLimitResumeEnabled');
    expect(keys).toContain('toolLoopAutoInterrupt');
  });

  it('Overnight turns on the two protections that only make sense unattended', () => {
    expect(OVERNIGHT_PROFILE.values.instanceProviderLimitResumeEnabled).toBe(true);
    expect(OVERNIGHT_PROFILE.values.toolLoopAutoInterrupt).toBe(true);
  });

  it('Overnight warns about context earlier than Interactive', () => {
    expect(OVERNIGHT_PROFILE.values.contextWarningThreshold!)
      .toBeLessThan(INTERACTIVE_PROFILE.values.contextWarningThreshold!);
  });

  it('reports only genuine differences, so a confirmation can be truthful', () => {
    const current = { ...DEFAULT_SETTINGS, toolLoopAutoInterrupt: true };
    const changes = diffProfile(OVERNIGHT_PROFILE, current);
    expect(changes.map((c) => c.key)).not.toContain('toolLoopAutoInterrupt');
  });

  it('records what each value changes from, not just to', () => {
    const [change] = diffProfile(OVERNIGHT_PROFILE, DEFAULT_SETTINGS)
      .filter((c) => c.key === 'toolLoopAutoInterrupt');
    expect(change).toMatchObject({ from: false, to: true });
  });

  it('knows when a profile is already fully applied', () => {
    const applied = { ...DEFAULT_SETTINGS, ...OVERNIGHT_PROFILE.values };
    expect(isProfileActive(OVERNIGHT_PROFILE, applied)).toBe(true);
    expect(activeProfile(applied)).toBe('overnight');
  });

  /**
   * A hand-tuned mix is not "Overnight". Claiming a profile is active when some
   * of its values differ would make the label a lie, and the label is the point.
   */
  it('reports null for a custom mix rather than the nearest profile', () => {
    const halfway = { ...DEFAULT_SETTINGS, toolLoopAutoInterrupt: true };
    expect(activeProfile(halfway)).toBeNull();
  });

  it('every profile is reachable by id', () => {
    for (const profile of SETTINGS_PROFILES) {
      expect(getSettingsProfile(profile.id)).toBe(profile);
    }
  });

  it('every profile explains itself in the operator\'s terms', () => {
    for (const profile of SETTINGS_PROFILES) {
      expect(profile.description.length).toBeGreaterThan(40);
      expect(profile.label.length).toBeGreaterThan(0);
    }
  });
});
