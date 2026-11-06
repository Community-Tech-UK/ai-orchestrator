import { describe, expect, it } from 'vitest';
import {
  allowanceFromRateLimitType,
  buildUsageLimitNotice,
  buildUsageWarningNotice,
  cleanAccountLabel,
} from './usage-limit-notice';

// Tuesday 20 October 2026, noon, in the machine's own time zone (as the reset text is).
const now = new Date(2026, 9, 20, 12).getTime();
const thursdayNight = new Date(2026, 9, 22, 23).getTime();
const base = { provider: 'claude', now, rawDetail: 'Provider rate limit "rejected" (seven_day). Resets at 11:00:00 PM.' };

describe('allowanceFromRateLimitType', () => {
  it.each([
    ['five_hour', 'session'],
    ['seven_day', 'weekly'],
    ['seven_day_opus', 'weekly'],
    ['seven_day_sonnet', 'weekly'],
    ['seven_day_overage_included', 'weekly'],
  ])('reads %s as %s', (type, allowance) => {
    expect(allowanceFromRateLimitType(type)).toBe(allowance);
  });

  it.each(['overage', 'PRIVATE_WINDOW_NAME', '', undefined, null, 7, { source: 'x' }, ['seven_day']])(
    'does not guess an allowance from %j', value => {
      expect(allowanceFromRateLimitType(value)).toBeUndefined();
    },
  );
});

describe('buildUsageLimitNotice', () => {
  it('names the account and the allowance, and gives the day, date and time when the reset is far off', () => {
    const { content, presentation } = buildUsageLimitNotice({ ...base, account: 'Work', allowance: 'weekly', resetAt: thursdayNight });
    expect(content).toContain('Your Work Claude account has used its weekly allowance.');
    expect(content).toMatch(/It resets on Thursday 22 October at 23:00\./);
    expect(content).toContain('What to do:');
    expect(presentation.action).toBe('switch-account');
  });

  it('gives only the time when the reset is within twelve hours', () => {
    const soon = new Date(2026, 9, 20, 17, 30).getTime();
    const { content } = buildUsageLimitNotice({ ...base, account: 'Work', allowance: 'session', resetAt: soon });
    expect(content).toContain('It resets at 17:30.');
    expect(content).not.toMatch(/Tuesday|October/);
  });

  it('does not invent a reset time when none is known, or when the one given has already passed', () => {
    expect(buildUsageLimitNotice({ ...base, allowance: 'weekly' }).content).not.toContain('resets');
    expect(buildUsageLimitNotice({ ...base, allowance: 'weekly', resetAt: now - 60_000 }).content).not.toContain('resets');
    expect(buildUsageLimitNotice({ ...base, allowance: 'weekly', resetAt: Number.NaN }).content).not.toContain('resets');
  });

  it('never prints the provider\'s own status or window names, and keeps them for Details', () => {
    const { content, presentation } = buildUsageLimitNotice({ ...base, allowance: 'weekly', resetAt: thursdayNight });
    expect(content).not.toMatch(/rejected|seven_day|rate limit/i);
    expect(presentation.rawDetail).toBe(base.rawDetail);
    expect(presentation.category).toBe('quota');
  });

  it('leaves the account out for an unnamed account, and never repeats the provider in a name', () => {
    expect(buildUsageLimitNotice({ ...base, allowance: 'weekly' }).content).toContain('Your Claude account has used its weekly allowance.');
    expect(buildUsageLimitNotice({ ...base, account: 'Claude Max', allowance: 'weekly' }).content)
      .toContain('Your Max Claude account has used');
  });

  it('says plainly that Harness is moving the conversation when it is switching accounts', () => {
    const { content, presentation } = buildUsageLimitNotice({
      ...base, account: 'Work', allowance: 'weekly', handling: { kind: 'switching', metadata: { accountFailover: true } },
    });
    expect(content).toContain('No action needed: Harness is moving this conversation to another account.');
    expect(content).not.toContain('What to do:');
    expect(presentation).not.toHaveProperty('action');
  });

  it.each([
    [{ autoResume: true, heldMessage: false }, 'Harness will pick this session up again once the allowance resets.'],
    [{ autoResume: true, heldMessage: true }, 'Your message will be sent again automatically once the allowance resets.'],
    [{ autoResume: false, heldMessage: true }, 'Your message was not sent. Press Resume, or send it again once the allowance resets.'],
    [{ autoResume: false, heldMessage: false }, 'This session is on hold until the allowance resets.'],
  ])('tells the user what happens to the session and message when parked: %j', (state, sentence) => {
    const { content } = buildUsageLimitNotice({
      ...base, account: 'Work', allowance: 'weekly', handling: { kind: 'parked', ...state, metadata: { providerLimitParked: true } },
    });
    expect(content).toContain(sentence);
  });

  it('does not let a hostile account label or provider id into the sentence unchecked', () => {
    const { content } = buildUsageLimitNotice({ ...base, provider: 'PRIVATE_PROVIDER_ID', account: 'Work\nINJECTED LINE\u0000', allowance: 'weekly' });
    expect(content).not.toContain('PRIVATE_PROVIDER_ID');
    expect(content).not.toContain('\n');
    expect(content).not.toContain('\u0000');
  });

  it('carries, beside its words, what Harness did, the presentation and the window it speaks for', () => {
    const { metadata, presentation } = buildUsageLimitNotice({
      ...base, account: 'Work', accountProfileId: 'work-1', allowance: 'weekly', resetAt: thursdayNight,
      handling: { kind: 'parked', autoResume: true, heldMessage: false, metadata: { providerLimitParked: true } },
    });
    expect(metadata).toEqual({
      providerLimitParked: true,
      errorPresentation: presentation,
      usageLimitWindow: { provider: 'claude', account: 'work-1', resetAt: thursdayNight, announcedAt: now },
    });
  });

  it('records the reset the user was told, so a reset that has passed or is unknown is not recorded', () => {
    expect(buildUsageLimitNotice({ ...base, resetAt: now - 60_000 }).metadata['usageLimitWindow']).not.toHaveProperty('resetAt');
    expect(buildUsageLimitNotice({ ...base }).metadata['usageLimitWindow']).toEqual({ provider: 'claude', account: 'default', announcedAt: now });
  });
});

describe('cleanAccountLabel', () => {
  it.each([
    ['Max A', 'claude', 'Max A'],
    ['work', 'claude', 'work'],
    ['Claude Max', 'claude', 'Max'],
    ['Personal Claude account', 'claude', 'Personal'],
    ['Claude', 'claude', undefined],
    ['Existing Claude account', 'claude', 'Existing'],
    ['   ', 'claude', undefined],
    [undefined, 'claude', undefined],
  ])('turns %j (%s) into %j', (label, provider, expected) => {
    expect(cleanAccountLabel(label, provider)).toBe(expected);
  });

  it('keeps a name short', () => {
    expect(cleanAccountLabel('x'.repeat(200), 'claude')).toHaveLength(40);
  });
});

describe('buildUsageWarningNotice', () => {
  it('is a calm heads-up, not a claim that the allowance is used up', () => {
    const content = buildUsageWarningNotice({ ...base, account: 'Work', allowance: 'weekly', resetAt: thursdayNight });
    expect(content).toContain('Your Work Claude account is close to its weekly allowance.');
    expect(content).toContain('It resets on Thursday 22 October at 23:00.');
    expect(content).toContain('No action needed: you can keep working.');
    expect(content).not.toMatch(/has used|rejected|allowed_warning|seven_day/);
  });

  it('leaves out a reset it does not know', () => {
    expect(buildUsageWarningNotice({ ...base, allowance: 'session' })).not.toContain('resets');
  });
});
