import { describe, expect, it, vi } from 'vitest';
import { ImapMcpMailboxReader } from './browser-imap-mailbox-reader';
import { BrowserEmailCodeReader } from './browser-email-code-reader';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const T0 = Date.parse('2026-07-07T20:00:00Z');

function makeClient(
  summaries: Array<{ uid: number; from?: string; subject?: string; date?: string; snippet?: string }>,
  bodies: Record<number, { text?: string; html?: string }> = {},
) {
  return {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'search_messages') {
        return summaries;
      }
      if (name === 'read_message') {
        const body = bodies[args['uid'] as number];
        if (!body) {
          throw new Error('read failed');
        }
        return { ...body, from: 'x', subject: 'y', date: new Date(T0).toISOString() };
      }
      throw new Error(`unexpected tool ${name}`);
    }),
  };
}

describe('ImapMcpMailboxReader', () => {
  it('maps summaries + full bodies to MailboxMessages, newest first', async () => {
    const client = makeClient(
      [
        {
          uid: 11,
          from: 'Portal <noreply@in-tendhost.co.uk>',
          subject: 'Your verification code',
          date: new Date(T0 - 60_000).toISOString(),
          snippet: 'snippet-11',
        },
        {
          uid: 12,
          from: 'noreply@in-tendhost.co.uk',
          subject: 'Newer mail',
          date: new Date(T0 - 10_000).toISOString(),
          snippet: 'snippet-12',
        },
      ],
      {
        11: { text: 'Your code is 482913' },
        12: { text: 'Nothing here' },
      },
    );
    const reader = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      now: () => T0,
    });

    const messages = await reader.search({ sinceMs: T0 - 10 * 60_000 });

    expect(messages.map((m) => m.id)).toEqual(['12', '11']);
    expect(messages[1]).toMatchObject({
      from: 'Portal <noreply@in-tendhost.co.uk>',
      subject: 'Your verification code',
      textBody: 'Your code is 482913',
      receivedAt: T0 - 60_000,
    });
    // The IMAP search used a date-granular SINCE derived from sinceMs.
    expect(client.callTool).toHaveBeenCalledWith(
      'search_messages',
      expect.objectContaining({ mailbox: 'INBOX', since: '2026-07-07' }),
    );
  });

  it('post-filters messages older than sinceMs (IMAP SINCE is date-granular)', async () => {
    const client = makeClient(
      [
        { uid: 1, from: 'a@x.com', date: new Date(T0 - 8 * 3_600_000).toISOString() },
        { uid: 2, from: 'b@x.com', date: new Date(T0 - 60_000).toISOString() },
      ],
      { 1: { text: 'old' }, 2: { text: 'new' } },
    );
    const reader = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      now: () => T0,
    });

    const messages = await reader.search({ sinceMs: T0 - 30 * 60_000 });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('2');
  });

  it('falls back to the search snippet when the full body cannot be read', async () => {
    const client = makeClient(
      [{ uid: 5, from: 'a@x.com', date: new Date(T0).toISOString(), snippet: 'code: 9911' }],
      {}, // read_message always fails
    );
    const reader = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      now: () => T0,
    });

    const messages = await reader.search({ sinceMs: T0 - 60_000 });

    expect(messages[0]!.textBody).toBe('code: 9911');
  });

  it('strips HTML when a message has no text part', async () => {
    const client = makeClient(
      [{ uid: 7, from: 'a@x.com', date: new Date(T0).toISOString() }],
      { 7: { html: '<p>Your <b>code</b> is</p><p>771122</p>' } },
    );
    const reader = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      now: () => T0,
    });

    const messages = await reader.search({ sinceMs: T0 - 60_000 });

    expect(messages[0]!.textBody).toContain('771122');
    expect(messages[0]!.textBody).not.toContain('<p>');
  });

  it('caps body fetches at the configured limit, newest first', async () => {
    const summaries = Array.from({ length: 8 }, (_, i) => ({
      uid: i + 1,
      from: 'a@x.com',
      date: new Date(T0 - (8 - i) * 1_000).toISOString(),
    }));
    const bodies = Object.fromEntries(
      summaries.map((s) => [s.uid, { text: `body-${s.uid}` }]),
    );
    const client = makeClient(summaries, bodies);
    const reader = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      bodyFetchLimit: 3,
      now: () => T0,
    });

    const messages = await reader.search({ sinceMs: T0 - 60_000 });

    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.id)).toEqual(['8', '7', '6']);
    const readCalls = client.callTool.mock.calls.filter(([name]) => name === 'read_message');
    expect(readCalls).toHaveLength(3);
  });

  it('works end-to-end with the email-code reader against a fake mailbox', async () => {
    const client = makeClient(
      [
        {
          uid: 21,
          from: 'In-Tend <noreply@in-tendhost.co.uk>',
          subject: 'Registration verification',
          date: new Date(T0 - 30_000).toISOString(),
        },
        {
          uid: 22,
          from: 'unrelated@elsewhere.com',
          subject: 'Your other code 999999',
          date: new Date(T0 - 5_000).toISOString(),
        },
      ],
      {
        21: { text: 'Hello,\nYour verification code is 335577\nThanks' },
        22: { text: 'Your code is 999999' },
      },
    );
    const mailbox = new ImapMcpMailboxReader({
      server: { command: 'node', args: [] },
      client,
      now: () => T0,
    });
    const codeReader = new BrowserEmailCodeReader({ reader: mailbox, now: () => T0 });

    const result = await codeReader.fetchCode({
      expectedSenderDomains: ['in-tendhost.co.uk'],
      sinceMs: T0 - 10 * 60_000,
      withinMs: 10 * 60_000,
    });

    // The unrelated sender's newer mail is ignored; the site's code wins.
    expect(result).toMatchObject({ code: '335577', messageId: '21' });
  });
});
