import { describe, expect, it } from 'vitest';
import {
  chooseChromeProfile,
  chromeProfileLabel,
  describeChromeProfileChoice,
  tabMatchesChromeProfileChoice,
  type ChromeProfileChoice,
} from './browser-chrome-profile-choice';

const MAIN = '0b779001-ea2a-4929-9faf-3ba30930ae8a';
const OTHER = 'cfe036dd-7881-414a-af83-a02bf92f537b';

function chosen(result: ReturnType<typeof chooseChromeProfile>): ChromeProfileChoice {
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result;
}

describe('chooseChromeProfile', () => {
  it('picks the profile agents have used for the website, even when another is used more overall', () => {
    const choice = chosen(chooseChromeProfile({
      connected: [OTHER, MAIN],
      usage: [
        { extensionInstanceId: MAIN, siteActions: 1948, totalActions: 200 },
        { extensionInstanceId: OTHER, siteActions: 3, totalActions: 900 },
      ],
    }));

    expect(choice).toMatchObject({ extensionInstanceId: MAIN, basis: 'site_history' });
  });

  it('falls back to the profile agents use most on the computer when nobody has used the website', () => {
    const choice = chosen(chooseChromeProfile({
      connected: [OTHER, MAIN],
      usage: [
        { extensionInstanceId: MAIN, siteActions: 0, totalActions: 24_395 },
        { extensionInstanceId: OTHER, siteActions: 0, totalActions: 328 },
      ],
    }));

    expect(choice).toMatchObject({ extensionInstanceId: MAIN, basis: 'most_used' });
  });

  it('leaves the open unbound when the computer has one profile or no history', () => {
    expect(chosen(chooseChromeProfile({
      connected: [MAIN],
      usage: [{ extensionInstanceId: MAIN, siteActions: 5, totalActions: 5 }],
    })).extensionInstanceId).toBeUndefined();
    expect(chosen(chooseChromeProfile({ connected: [MAIN, OTHER], usage: [] })).extensionInstanceId)
      .toBeUndefined();
  });

  it('ignores history from a profile that is not open now, and names it when it is the only one with the website', () => {
    const choice = chosen(chooseChromeProfile({
      connected: [OTHER],
      usage: [
        { extensionInstanceId: MAIN, siteActions: 40, totalActions: 400 },
        { extensionInstanceId: OTHER, siteActions: 0, totalActions: 30 },
      ],
    }));

    expect(choice.extensionInstanceId).toBeUndefined();
    expect(choice.closedProfileWithSiteHistory).toBe(MAIN);
  });

  it('honours a requested profile by short name or full id', () => {
    expect(chosen(chooseChromeProfile({
      connected: [MAIN, OTHER],
      usage: [{ extensionInstanceId: MAIN, siteActions: 9, totalActions: 9 }],
      requested: chromeProfileLabel(OTHER),
    }))).toMatchObject({ extensionInstanceId: OTHER, basis: 'requested' });
    expect(chosen(chooseChromeProfile({ connected: [MAIN], usage: [], requested: MAIN })))
      .toMatchObject({ extensionInstanceId: MAIN, basis: 'requested' });
  });

  it('refuses a requested profile that is not open, naming the open ones', () => {
    const result = chooseChromeProfile({ connected: [MAIN, OTHER], usage: [], requested: 'deadbeef' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('chrome_profile_not_open');
    expect(!result.ok && result.reason).toContain('0b779001, cfe036dd');
  });
});

describe('tabMatchesChromeProfileChoice', () => {
  const base = { ok: true as const, connected: [MAIN, OTHER] };

  it('limits existing tabs to the chosen profile for a requested or site-history choice', () => {
    for (const basis of ['requested', 'site_history'] as const) {
      const choice = { ...base, extensionInstanceId: MAIN, basis };
      expect(tabMatchesChromeProfileChoice(choice, { extensionInstanceId: MAIN })).toBe(true);
      expect(tabMatchesChromeProfileChoice(choice, { extensionInstanceId: OTHER })).toBe(false);
    }
  });

  it('accepts a tab in any profile when the choice only came from overall use', () => {
    const choice = { ...base, extensionInstanceId: MAIN, basis: 'most_used' as const };
    expect(tabMatchesChromeProfileChoice(choice, { extensionInstanceId: OTHER })).toBe(true);
    expect(tabMatchesChromeProfileChoice(base, { extensionInstanceId: OTHER })).toBe(true);
  });
});

describe('describeChromeProfileChoice', () => {
  it('says which profile the tab is in, why, and how to try the others', () => {
    const note = describeChromeProfileChoice(
      { ok: true, connected: [MAIN, OTHER], extensionInstanceId: MAIN, basis: 'site_history' },
      MAIN,
      'www.facebook.com',
    );

    expect(note).toBe(
      'chrome_profile: this tab is in Chrome profile 0b779001, chosen because agents have used '
      + 'www.facebook.com there before. Other Chrome profiles open on this computer: cfe036dd. '
      + 'If the page is signed out or shows the wrong account, call browser.find_or_open again '
      + 'with chromeProfile set to one of those.',
    );
  });

  it('says nothing for a computer with one profile', () => {
    expect(describeChromeProfileChoice({ ok: true, connected: [MAIN] }, MAIN, 'example.com')).toBeUndefined();
  });

  it('points at a closed profile that holds the website history', () => {
    const note = describeChromeProfileChoice(
      { ok: true, connected: [OTHER], closedProfileWithSiteHistory: MAIN },
      OTHER,
      'www.facebook.com',
    );

    expect(note).toContain('agents have used www.facebook.com in Chrome profile 0b779001');
    expect(note).toContain('ask the user to open that Chrome profile');
  });
});
