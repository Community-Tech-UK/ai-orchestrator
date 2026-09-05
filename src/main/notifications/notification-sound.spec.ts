import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NOTIFICATION_SOUND_MODE,
  resolveSoundMode,
  shouldBeSilent,
} from './notification-sound';

describe('shouldBeSilent (N10)', () => {
  it('never sounds when the mode is never', () => {
    for (const focused of [true, false]) {
      for (const urgency of ['normal', 'critical'] as const) {
        expect(shouldBeSilent({ mode: 'never', focused, urgency })).toBe(true);
      }
    }
  });

  it('always sounds when the mode is always', () => {
    for (const focused of [true, false]) {
      expect(shouldBeSilent({ mode: 'always', focused, urgency: 'normal' })).toBe(false);
    }
  });

  it('stays quiet on a focused window in blurred mode', () => {
    expect(shouldBeSilent({ mode: 'blurred', focused: true, urgency: 'normal' })).toBe(true);
  });

  it('sounds when you are away, which is the point', () => {
    expect(shouldBeSilent({ mode: 'blurred', focused: false, urgency: 'normal' })).toBe(false);
  });

  /**
   * The case the whole feature exists for. Swallowing a decision-needed alert
   * because a window happens to be focused is how an overnight run sits blocked
   * until morning.
   */
  it('sounds for a critical alert even when focused', () => {
    expect(shouldBeSilent({ mode: 'blurred', focused: true, urgency: 'critical' })).toBe(false);
  });

  it('still respects an explicit never for a critical alert', () => {
    expect(shouldBeSilent({ mode: 'never', focused: false, urgency: 'critical' })).toBe(true);
  });
});

describe('resolveSoundMode', () => {
  it('accepts the three valid modes', () => {
    for (const mode of ['always', 'blurred', 'never'] as const) {
      expect(resolveSoundMode(mode)).toBe(mode);
    }
  });

  /** A corrupted value must not silence every notification. */
  it('falls back to the default for anything else', () => {
    for (const bad of [undefined, null, '', 'loud', 42, {}]) {
      expect(resolveSoundMode(bad)).toBe(DEFAULT_NOTIFICATION_SOUND_MODE);
    }
  });

  it('defaults to sounding only when you are away', () => {
    expect(DEFAULT_NOTIFICATION_SOUND_MODE).toBe('blurred');
  });
});
