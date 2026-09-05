/**
 * S4.1 — Overnight and Interactive as switchable profiles.
 *
 * Decision 9 chose profiles over changing defaults for everyone, and that is
 * the right shape: the settings an unattended run wants are actively wrong for
 * someone sitting at the keyboard. Auto-interrupting a tool loop is protective
 * overnight and rude when you are watching and about to intervene yourself.
 *
 * **This changes no defaults.** A profile is an explicit set of values applied
 * when you ask for it; installing this file does not alter anyone's settings.
 * `INTERACTIVE_PROFILE` records today's shipped values so switching back is
 * exact rather than approximate — a "restore defaults" that guesses is how a
 * profile feature loses trust.
 *
 * **NOT WIRED.** Nothing applies these yet. The data and the diff/active-profile
 * policy are complete and tested, but there is no picker in Settings and no CLI
 * verb, so switching profiles is not something a user can currently do. This is
 * recorded rather than papered over: a profile module that nothing can apply is
 * a data file, not a feature, and the honest label for it is unwired. Wiring is
 * a settings-row plus an apply handler; it was left out rather than half-done.
 */

import type { AppSettings } from './settings.types';

export type SettingsProfileId = 'overnight' | 'interactive';

/** A profile only ever names keys it deliberately sets. */
export type SettingsProfileValues = Partial<Pick<
  AppSettings,
  | 'instanceProviderLimitResumeEnabled'
  | 'toolLoopAutoInterrupt'
  | 'contextWarningThreshold'
  | 'notifyOnLoopTerminal'
  | 'notificationSoundMode'
>>;

export interface SettingsProfile {
  id: SettingsProfileId;
  label: string;
  /** Why this profile exists, in the operator's terms. */
  description: string;
  values: SettingsProfileValues;
}

export const OVERNIGHT_PROFILE: SettingsProfile = {
  id: 'overnight',
  label: 'Overnight',
  description:
    'For runs you are not watching. Recovers from provider limits on its own, '
    + 'stops an agent stuck repeating a tool call, warns earlier about context, '
    + 'and makes sure a finished or blocked run reaches you.',
  values: {
    // A provider limit overnight means the run is simply dead until morning
    // unless it can resume itself.
    instanceProviderLimitResumeEnabled: true,
    // Protective when nobody is watching; rude when someone is.
    toolLoopAutoInterrupt: true,
    // Earlier warning, because nobody is there to notice the late one.
    contextWarningThreshold: 70,
    notifyOnLoopTerminal: true,
    notificationSoundMode: 'blurred',
  },
};

export const INTERACTIVE_PROFILE: SettingsProfile = {
  id: 'interactive',
  label: 'Interactive',
  description:
    'Today\'s behaviour, for when you are at the keyboard: nothing resumes or '
    + 'interrupts on your behalf.',
  values: {
    instanceProviderLimitResumeEnabled: false,
    toolLoopAutoInterrupt: false,
    contextWarningThreshold: 80,
    notifyOnLoopTerminal: true,
    notificationSoundMode: 'blurred',
  },
};

export const SETTINGS_PROFILES: readonly SettingsProfile[] = [
  OVERNIGHT_PROFILE,
  INTERACTIVE_PROFILE,
];

export function getSettingsProfile(id: SettingsProfileId): SettingsProfile {
  return id === 'overnight' ? OVERNIGHT_PROFILE : INTERACTIVE_PROFILE;
}

export interface ProfileChange {
  key: keyof SettingsProfileValues;
  from: unknown;
  to: unknown;
}

/**
 * What applying a profile would change, given the current settings.
 *
 * Returns only genuine differences so a confirmation can say "this changes 2
 * settings" truthfully rather than listing five and altering two.
 */
export function diffProfile(
  profile: SettingsProfile,
  current: Partial<AppSettings>,
): ProfileChange[] {
  const changes: ProfileChange[] = [];
  for (const [key, to] of Object.entries(profile.values) as [keyof SettingsProfileValues, unknown][]) {
    const from = (current as Record<string, unknown>)[key];
    if (from !== to) changes.push({ key, from, to });
  }
  return changes;
}

/** True when the current settings already match the profile exactly. */
export function isProfileActive(
  profile: SettingsProfile,
  current: Partial<AppSettings>,
): boolean {
  return diffProfile(profile, current).length === 0;
}

/**
 * Which profile the current settings correspond to, or `null` for a custom mix.
 *
 * `null` is the honest answer for a hand-tuned configuration: claiming a
 * profile is active when two of its five values differ would make the label a
 * lie, and the label is the whole point.
 */
export function activeProfile(current: Partial<AppSettings>): SettingsProfileId | null {
  for (const profile of SETTINGS_PROFILES) {
    if (isProfileActive(profile, current)) return profile.id;
  }
  return null;
}
