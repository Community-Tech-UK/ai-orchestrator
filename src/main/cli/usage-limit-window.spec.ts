import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../shared/types/instance.types';
import {
  USAGE_LIMIT_WINDOW_KEY,
  findAnnouncedUsageLimit,
  usageLimitAccountKey,
  usageLimitWindow,
} from './usage-limit-window';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = new Date(2026, 9, 20, 12).getTime();
const thursdayNight = new Date(2026, 9, 22, 23).getTime();

const note = (tag: unknown, type: OutputMessage['type'] = 'system'): OutputMessage => ({
  id: 'n', timestamp: now, type, content: 'a note', metadata: { [USAGE_LIMIT_WINDOW_KEY]: tag },
});
const earlier = (overrides: Partial<Parameters<typeof usageLimitWindow>[0]> = {}) =>
  note(usageLimitWindow({ provider: 'claude', resetAt: thursdayNight, now: now - 10 * MINUTE, ...overrides }));
const event = (overrides: Partial<Parameters<typeof usageLimitWindow>[0]> = {}) =>
  usageLimitWindow({ provider: 'claude', resetAt: thursdayNight, now, ...overrides });

describe('usageLimitAccountKey', () => {
  it.each([
    ['work-1', 'work-1'],
    ['legacy', 'default'],
    [undefined, 'default'],
    [null, 'default'],
    ['', 'default'],
  ])('reads %j as %s', (profileId, key) => {
    expect(usageLimitAccountKey(profileId)).toBe(key);
  });
});

describe('usageLimitWindow', () => {
  it('records the provider, the account, the reset the user was told and when it was said', () => {
    expect(usageLimitWindow({ provider: 'codex', accountProfileId: 'work-1', resetAt: thursdayNight, now }))
      .toEqual({ provider: 'codex', account: 'work-1', resetAt: thursdayNight, announcedAt: now });
  });

  it('leaves the reset out when none was told', () => {
    expect(usageLimitWindow({ provider: 'codex', now })).toEqual({ provider: 'codex', account: 'default', announcedAt: now });
  });
});

describe('findAnnouncedUsageLimit', () => {
  it('finds the note for the same provider, account and window', () => {
    const noted = earlier();
    expect(findAnnouncedUsageLimit([noted], event())).toBe(noted);
  });

  it('is the same window when the reset was read a few minutes differently', () => {
    expect(findAnnouncedUsageLimit([earlier()], event({ resetAt: thursdayNight + 20 * MINUTE }))).toBeDefined();
  });

  it('is the same window when either side could not name a reset', () => {
    expect(findAnnouncedUsageLimit([earlier({ resetAt: undefined })], event())).toBeDefined();
    expect(findAnnouncedUsageLimit([earlier()], event({ resetAt: undefined }))).toBeDefined();
  });

  it('is a different window when the reset is more than an hour away from the one told', () => {
    expect(findAnnouncedUsageLimit([earlier()], event({ resetAt: thursdayNight + 7 * 24 * HOUR }))).toBeUndefined();
    expect(findAnnouncedUsageLimit([earlier()], event({ resetAt: thursdayNight + 2 * HOUR }))).toBeUndefined();
  });

  it('is another window for another provider or another account', () => {
    expect(findAnnouncedUsageLimit([earlier()], event({ provider: 'codex' }))).toBeUndefined();
    expect(findAnnouncedUsageLimit([earlier({ accountProfileId: 'work-1' })], event({ accountProfileId: 'home-2' }))).toBeUndefined();
    expect(findAnnouncedUsageLimit([earlier({ accountProfileId: 'work-1' })], event({ accountProfileId: 'work-1' }))).toBeDefined();
  });

  it('counts the default account the same whether the profile is missing or named legacy', () => {
    expect(findAnnouncedUsageLimit([earlier({ accountProfileId: 'legacy' })], event())).toBeDefined();
  });

  it('is over once the told reset has passed', () => {
    const finished = earlier({ resetAt: now - HOUR, now: now - 3 * HOUR });
    expect(findAnnouncedUsageLimit([finished], event({ resetAt: now + 5 * HOUR }))).toBeUndefined();
    expect(findAnnouncedUsageLimit([finished], event({ resetAt: undefined }))).toBeUndefined();
  });

  it('lets a note with no reset speak for an hour, and no longer', () => {
    expect(findAnnouncedUsageLimit([earlier({ resetAt: undefined, now: now - 50 * MINUTE })], event())).toBeDefined();
    expect(findAnnouncedUsageLimit([earlier({ resetAt: undefined, now: now - 70 * MINUTE })], event())).toBeUndefined();
  });

  it('takes a note from the last two minutes for the same refusal, whatever reset each side read', () => {
    const fresh = earlier({ now: now - 30_000 });
    expect(findAnnouncedUsageLimit([fresh], event({ resetAt: thursdayNight + 5 * 24 * HOUR }))).toBe(fresh);
    expect(findAnnouncedUsageLimit([earlier({ now: now - 5 * MINUTE })], event({ resetAt: thursdayNight + 5 * 24 * HOUR }))).toBeUndefined();
  });

  it('reads the newest note first and ignores messages that carry no tag, or a damaged one', () => {
    const noted = earlier();
    const transcript = [
      noted,
      { id: 'a', timestamp: now, type: 'assistant', content: 'later reply' } as OutputMessage,
      note('not an object'),
      note({ provider: 'claude' }),
      note({ provider: 'claude', account: 'default', announcedAt: 'yesterday' }),
      note(null),
    ];
    expect(findAnnouncedUsageLimit(transcript, event())).toBe(noted);
    expect(findAnnouncedUsageLimit(transcript.slice(1), event())).toBeUndefined();
  });

  it('finds nothing in an empty transcript', () => {
    expect(findAnnouncedUsageLimit([], event())).toBeUndefined();
  });
});
