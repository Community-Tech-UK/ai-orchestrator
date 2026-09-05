/**
 * N10 — focus-aware notification sound.
 *
 * `notification-service.ts` hardcoded `silent: false`, so every notification
 * made a sound with no way to change it. The common complaint that motivates
 * this is not "I want silence" but "I want to hear the overnight run finish
 * from another room, and not be pinged while I am sitting here watching it".
 *
 * Scope note: Decision 8(d) asks for DISTINCT sounds per event class. That
 * needs audio assets and a choice about what they sound like, so it is not
 * built here. This delivers the focus-aware half using the OS sound, which is
 * the part that needs no decision.
 */

export type NotificationSoundMode = 'always' | 'blurred' | 'never';

export const DEFAULT_NOTIFICATION_SOUND_MODE: NotificationSoundMode = 'blurred';

export interface SoundDecisionInput {
  mode: NotificationSoundMode;
  /** Whether any app window currently has focus. */
  focused: boolean;
  /**
   * Critical notifications ignore `blurred` and always sound. A run that needs
   * a decision is the case this whole feature exists for; suppressing it
   * because a window happens to be focused is how an overnight run sits
   * blocked until morning.
   */
  urgency: 'normal' | 'critical';
}

/** True when the OS notification should be silent. */
export function shouldBeSilent(input: SoundDecisionInput): boolean {
  if (input.mode === 'never') return true;
  if (input.mode === 'always') return false;
  if (input.urgency === 'critical') return false;
  return input.focused;
}

export function isNotificationSoundMode(value: unknown): value is NotificationSoundMode {
  return value === 'always' || value === 'blurred' || value === 'never';
}

/** Tolerate an unset or corrupted stored value without silencing everything. */
export function resolveSoundMode(stored: unknown): NotificationSoundMode {
  return isNotificationSoundMode(stored) ? stored : DEFAULT_NOTIFICATION_SOUND_MODE;
}
