import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';

/**
 * Which Chrome profile `find_or_open` uses when one computer runs the Browser
 * Gateway extension in several Chrome profiles. Each profile is one extension
 * install with its own id; agents see its first characters as `chromeProfile`.
 *
 * Before this, a new tab opened in whichever profile polled first. On
 * 2026-11-13 a nightly Facebook search on windows-pc opened in a profile that
 * was not signed in to Facebook, although every earlier run had worked in the
 * signed-in one. Sign-ins belong to a profile, so the best guess is the
 * profile agents have already worked in on that website, then the profile
 * agents use most on that computer.
 */

const CHROME_PROFILE_LABEL_LENGTH = 8;

/** How far back agent activity counts towards choosing a profile. */
export const CHROME_PROFILE_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60_000;

/** Successful agent actions in one Chrome profile on one computer. */
export interface ChromeProfileUse {
  extensionInstanceId: string;
  /** On the website being opened. */
  siteActions: number;
  /** On any website. */
  totalActions: number;
}

export type ChromeProfileBasis = 'requested' | 'site_history' | 'most_used';

export interface ChromeProfileChoice {
  ok: true;
  /** Profiles currently connected on the computer. */
  connected: readonly string[];
  /** Set when the open must run in this profile. */
  extensionInstanceId?: string;
  basis?: ChromeProfileBasis;
  /** A profile that is not open (or not taking commands) now but where agents have used the website. */
  closedProfileWithSiteHistory?: string;
}

export type ChromeProfileChoiceResult = ChromeProfileChoice | { ok: false; reason: string };

/** The short, stable name agents see and pass back as `chromeProfile`. */
export function chromeProfileLabel(extensionInstanceId: string): string {
  return extensionInstanceId.slice(0, CHROME_PROFILE_LABEL_LENGTH);
}

export function chooseChromeProfile(input: {
  connected: readonly string[];
  usage: readonly ChromeProfileUse[];
  requested?: string;
}): ChromeProfileChoiceResult {
  const { connected, usage } = input;
  if (input.requested) {
    return chooseRequestedProfile(connected, input.requested);
  }

  const useOf = (id: string): ChromeProfileUse =>
    usage.find((entry) => entry.extensionInstanceId === id)
      ?? { extensionInstanceId: id, siteActions: 0, totalActions: 0 };
  const ranked = connected
    .map(useOf)
    .sort((a, b) => b.siteActions - a.siteActions
      || b.totalActions - a.totalActions
      || a.extensionInstanceId.localeCompare(b.extensionInstanceId));
  const closedProfileWithSiteHistory = ranked.some((entry) => entry.siteActions > 0)
    ? undefined
    : usage
      .filter((entry) => entry.siteActions > 0 && !connected.includes(entry.extensionInstanceId))
      .sort((a, b) => b.siteActions - a.siteActions)[0]?.extensionInstanceId;
  const choice: ChromeProfileChoice = {
    ok: true,
    connected,
    ...(closedProfileWithSiteHistory ? { closedProfileWithSiteHistory } : {}),
  };

  // One profile (or none reporting yet): nothing to choose between.
  const best = ranked[0];
  if (connected.length < 2 || !best || best.totalActions === 0) {
    return choice;
  }
  return {
    ...choice,
    extensionInstanceId: best.extensionInstanceId,
    basis: best.siteActions > 0 ? 'site_history' : 'most_used',
  };
}

function chooseRequestedProfile(
  connected: readonly string[],
  requested: string,
): ChromeProfileChoiceResult {
  const matches = connected.filter((id) => id === requested || chromeProfileLabel(id) === requested);
  if (matches.length === 1) {
    return { ok: true, connected, extensionInstanceId: matches[0]!, basis: 'requested' };
  }
  const open = connected.length > 0
    ? `Chrome profiles open on this computer: ${connected.map(chromeProfileLabel).join(', ')}.`
    : 'No Chrome profile on this computer is reporting to Browser Gateway.';
  return {
    ok: false,
    reason: `chrome_profile_not_open: Chrome profile "${requested}" is not open on this computer. ${open}`
      + ' Pass one of those as chromeProfile, or leave chromeProfile out.',
  };
}

/**
 * A choice made from the request or from site history also decides which
 * existing tabs count: a tab for the website in another profile is likely
 * signed in to a different account, or not at all. A choice from overall use
 * only says where to open a new tab.
 */
export function tabMatchesChromeProfileChoice(
  choice: ChromeProfileChoice,
  tab: Pick<BrowserExistingTabAttachment, 'extensionInstanceId'>,
): boolean {
  if (!choice.extensionInstanceId || choice.basis === 'most_used') {
    return true;
  }
  return tab.extensionInstanceId === choice.extensionInstanceId;
}

/**
 * The agent-facing note on a `find_or_open` result. Agents read `reason`, so
 * this names the profile the tab is in, why, and how to try another one.
 */
export function describeChromeProfileChoice(
  choice: ChromeProfileChoice,
  tabInstanceId: string | undefined,
  site: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const others = choice.connected.filter((id) => id !== tabInstanceId);
  if (tabInstanceId && choice.connected.length > 1 && others.length > 0) {
    parts.push(`chrome_profile: this tab is in Chrome profile ${chromeProfileLabel(tabInstanceId)}`
      + `${choiceExplanation(choice, tabInstanceId, site)}.`
      + ` Other Chrome profiles open on this computer: ${others.map(chromeProfileLabel).join(', ')}.`
      + ' If the page is signed out or shows the wrong account, call browser.find_or_open again'
      + ' with chromeProfile set to one of those.');
  }
  if (choice.closedProfileWithSiteHistory && site) {
    parts.push(`chrome_profile_closed: agents have used ${site} in Chrome profile`
      + ` ${chromeProfileLabel(choice.closedProfileWithSiteHistory)} on this computer, which is not open or not working now.`
      + ' If this page is signed out, ask the user to open that Chrome profile.');
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function choiceExplanation(
  choice: ChromeProfileChoice,
  tabInstanceId: string,
  site: string | undefined,
): string {
  if (choice.extensionInstanceId !== tabInstanceId) {
    return '';
  }
  switch (choice.basis) {
    case 'requested':
      return ', as requested';
    case 'site_history':
      return `, chosen because agents have used ${site ?? 'this website'} there before`;
    case 'most_used':
      return ', chosen because agents use it most on this computer';
    default:
      return '';
  }
}
