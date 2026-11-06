/**
 * Does the user expect a provider's CLI to work?
 *
 * The startup probe looks for five CLIs unconditionally, but most people only
 * use some of them. A CLI that is not installed is a problem only when the
 * user has shown they want it: they made it their default, or they added an
 * account for it. Otherwise it is simply not set up, and startup stays quiet
 * about it (the "healthy means hidden" rule).
 *
 * Harness creates an "existing account" entry for Claude, Codex and Copilot by
 * itself during a settings migration, whether or not the tool was ever used.
 * That entry says nothing about intent, so it only counts once an identity has
 * been verified through it (`expectedIdentity` / `expectedLogin`).
 */

import type { AppSettings } from '../../shared/types/settings.types';

export type ProbedProviderId = 'claude' | 'codex' | 'antigravity' | 'copilot' | 'cursor';

export type ProviderExpectationSettings = Pick<
  AppSettings,
  'defaultCli' | 'automationDefaultCli' | 'providerAccountProfiles' | 'copilotAccountProfiles'
>;

/** Why the user is expected to use the provider; `null` when nothing says so. */
export type ProviderExpectation = 'default' | 'account' | null;

function isChosen(chosen: string | undefined, id: ProbedProviderId): boolean {
  // `openai` is the legacy name kept in old settings files for Codex.
  return chosen === id || (id === 'codex' && chosen === 'openai');
}

function hasAccount(id: ProbedProviderId, settings: ProviderExpectationSettings): boolean {
  if (id === 'claude' || id === 'codex') {
    return (settings.providerAccountProfiles ?? []).some(
      (profile) => profile.provider === id
        && profile.enabled
        && (!profile.isLegacy || Boolean(profile.expectedIdentity)),
    );
  }
  if (id === 'copilot') {
    return (settings.copilotAccountProfiles ?? []).some(
      (profile) => !profile.isLegacy || Boolean(profile.expectedLogin),
    );
  }
  return false;
}

export function providerExpectation(
  id: ProbedProviderId,
  settings: ProviderExpectationSettings | null,
): ProviderExpectation {
  if (!settings) return null;
  if (isChosen(settings.defaultCli, id) || isChosen(settings.automationDefaultCli, id)) return 'default';
  return hasAccount(id, settings) ? 'account' : null;
}
