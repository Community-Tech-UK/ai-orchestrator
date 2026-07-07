import { describe, expect, it } from 'vitest';
import {
  BrowserEmailCodeReader,
  EmailCodeReaderError,
  extractVerificationCode,
  type MailboxMessage,
  type MailboxReader,
  type MailboxSearchCriteria,
} from './browser-email-code-reader';

/** In-memory mailbox fake. Returns messages newest-first, like the real reader. */
class FakeMailboxReader implements MailboxReader {
  constructor(private readonly messages: MailboxMessage[]) {}

  async search(criteria: MailboxSearchCriteria): Promise<MailboxMessage[]> {
    const matching = this.messages.filter((m) => m.receivedAt >= criteria.sinceMs);
    const sorted = [...matching].sort((a, b) => b.receivedAt - a.receivedAt);
    return criteria.limit ? sorted.slice(0, criteria.limit) : sorted;
  }
}

function message(overrides: Partial<MailboxMessage>): MailboxMessage {
  return {
    id: 'msg-1',
    from: 'noreply@example.gov.uk',
    subject: 'Your verification code',
    textBody: 'Your verification code is 482913.',
    receivedAt: 1_000_000,
    ...overrides,
  };
}

describe('BrowserEmailCodeReader.fetchCode', () => {
  it('accepts a sender whose domain exactly matches the allowlist', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([message({ from: 'noreply@example.gov.uk' })]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('482913');
    expect(result.matchedSender).toBe('noreply@example.gov.uk');
  });

  it('accepts a sender whose domain is a true subdomain of the allowlist entry (suffix match)', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({ from: 'noreply@notifications.example.gov.uk' }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.matchedSender).toBe('noreply@notifications.example.gov.uk');
  });

  it('matches case-insensitively', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([message({ from: 'NoReply@EXAMPLE.GOV.UK' })]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['Example.Gov.UK'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('482913');
  });

  it('rejects a lookalike domain that is a string-suffix but not a real subdomain', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([message({ from: 'noreply@evil-example.gov.uk' })]),
    });
    await expect(
      reader.fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 300_000,
        now: 1_000_000,
      }),
    ).rejects.toMatchObject({ code: 'no_matching_message' });
  });

  it('rejects a sender domain outside the allowlist entirely', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([message({ from: 'noreply@totally-unrelated.example' })]),
    });
    await expect(
      reader.fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 300_000,
        now: 1_000_000,
      }),
    ).rejects.toMatchObject({ code: 'no_matching_message' });
  });

  it('rejects a message that arrived before the recency window (too old)', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({ from: 'noreply@example.gov.uk', receivedAt: 600_000 }),
      ]),
    });
    await expect(
      reader.fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 300_000, // window start = max(900_000, 1_000_000-300_000) = 900_000
        now: 1_000_000,
      }),
    ).rejects.toMatchObject({ code: 'no_matching_message' });
  });

  it('rejects a message older than `withinMs` even if it is after `sinceMs`', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        // sinceMs allows it, but it's outside the 60s recency window.
        message({ from: 'noreply@example.gov.uk', receivedAt: 930_000 }),
      ]),
    });
    await expect(
      reader.fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 60_000, // window start = max(900_000, 1_000_000-60_000) = 940_000
        now: 1_000_000,
      }),
    ).rejects.toMatchObject({ code: 'no_matching_message' });
  });

  it('accepts a message right at the edge of the recency window', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({ from: 'noreply@example.gov.uk', receivedAt: 940_000 }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 60_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('482913');
  });

  it('picks the newest matching message when several match', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({
          id: 'old',
          from: 'noreply@example.gov.uk',
          receivedAt: 950_000,
          subject: 'code 111111',
          textBody: '',
        }),
        message({
          id: 'newest',
          from: 'noreply@example.gov.uk',
          receivedAt: 990_000,
          subject: 'code 222222',
          textBody: '',
        }),
        message({
          id: 'middle',
          from: 'noreply@example.gov.uk',
          receivedAt: 970_000,
          subject: 'code 333333',
          textBody: '',
        }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.messageId).toBe('newest');
    expect(result.code).toBe('222222');
  });

  it('throws no_matching_message when no message matches sender or window', async () => {
    const reader = new BrowserEmailCodeReader({ reader: new FakeMailboxReader([]) });
    const error = await reader
      .fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 300_000,
        now: 1_000_000,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailCodeReaderError);
    expect((error as EmailCodeReaderError).code).toBe('no_matching_message');
  });

  it('throws code_not_found when a message matches but has no extractable code', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({
          from: 'noreply@example.gov.uk',
          subject: 'Welcome to the service',
          textBody: 'Thanks for signing up. No code needed for this step.',
        }),
      ]),
    });
    const error = await reader
      .fetchCode({
        expectedSenderDomains: ['example.gov.uk'],
        sinceMs: 900_000,
        withinMs: 300_000,
        now: 1_000_000,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailCodeReaderError);
    expect((error as EmailCodeReaderError).code).toBe('code_not_found');
  });

  it('prefers a code found in the subject over one found in the body', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({
          from: 'noreply@example.gov.uk',
          subject: 'Your code is 111222',
          textBody: 'For reference, an unrelated code is 999888.',
        }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('111222');
  });

  it('falls back to the body when the subject has no code', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({
          from: 'noreply@example.gov.uk',
          subject: 'Action required',
          textBody: 'Your one-time passcode is 776655. It expires in 10 minutes.',
        }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('776655');
  });

  it('supports a "Name <email>" style From header', async () => {
    const reader = new BrowserEmailCodeReader({
      reader: new FakeMailboxReader([
        message({ from: 'GOV.UK Notify <noreply@notifications.example.gov.uk>' }),
      ]),
    });
    const result = await reader.fetchCode({
      expectedSenderDomains: ['example.gov.uk'],
      sinceMs: 900_000,
      withinMs: 300_000,
      now: 1_000_000,
    });
    expect(result.code).toBe('482913');
  });
});

describe('extractVerificationCode', () => {
  it('extracts a 6-digit code adjacent to a keyword', () => {
    expect(extractVerificationCode('Your verification code is 482913.', '')).toBe('482913');
  });

  it('extracts a 4-digit code adjacent to a keyword', () => {
    expect(extractVerificationCode('PIN: 4821', '')).toBe('4821');
  });

  it('extracts an 8-char alphanumeric code adjacent to a keyword', () => {
    expect(extractVerificationCode('Your code: A1B2C3D4', '')).toBe('A1B2C3D4');
  });

  it('extracts a code from a generic "use code X" phrasing', () => {
    expect(extractVerificationCode('', 'Use code 123456 to verify your account')).toBe('123456');
  });

  it('extracts a code that precedes the keyword', () => {
    expect(extractVerificationCode('', '654321 - one-time code for your login.')).toBe('654321');
  });

  it('extracts a standalone digit run on its own line, with no keyword nearby', () => {
    const body = 'Your code:\n\n482913\n\nExpires in 10 minutes.';
    expect(extractVerificationCode('', body)).toBe('482913');
  });

  it('extracts a standalone mixed alphanumeric token on its own line', () => {
    const body = 'Here is your token:\n\nA1B2C3D4\n\nUse it within 15 minutes.';
    expect(extractVerificationCode('', body)).toBe('A1B2C3D4');
  });

  it('does not match a 4-digit year mentioned in an ordinary sentence', () => {
    const body = 'This request was made in 2024. It is not a one-time code.';
    expect(extractVerificationCode('', body)).toBeNull();
  });

  it('does not match digits embedded inside a long phone number', () => {
    const body = 'Please call our support line on 07911123456 if you need help.';
    expect(extractVerificationCode('', body)).toBeNull();
  });

  it('does not match a 4-digit group inside a spaced-out phone number when no keyword is present', () => {
    const body = 'Call us on 020 7946 0958 for help.';
    expect(extractVerificationCode('', body)).toBeNull();
  });

  it('does not treat a plain word as a standalone alphanumeric code (must be mixed digits+letters)', () => {
    const body = 'Thanks,\n\nRegards\n\nThe Team';
    expect(extractVerificationCode('', body)).toBeNull();
  });

  it('returns null for empty subject and body', () => {
    expect(extractVerificationCode('', '')).toBeNull();
  });

  it('prefers the subject match over a body match', () => {
    expect(extractVerificationCode('code 111222', 'code 999888')).toBe('111222');
  });
});
