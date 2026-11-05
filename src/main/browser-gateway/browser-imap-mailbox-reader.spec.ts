import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapMcpClient, ImapMcpMailboxReader } from './browser-imap-mailbox-reader';
import { BrowserEmailCodeReader, MailboxReaderError } from './browser-email-code-reader';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

const T0 = Date.parse('2026-07-07T20:00:00Z');

/**
 * Fake imap MCP client that behaves like imap-mcp-server's search_messages:
 * FROM is a case-insensitive substring match on the whole From header, and the
 * newest `limit` matches are returned (summaries are listed oldest first).
 */
function makeClient(
  summaries: Array<{ uid: number; from?: string; subject?: string; date?: string; snippet?: string }>,
  bodies: Record<number, { text?: string; html?: string }> = {},
) {
  return {
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'search_messages') {
        const from = typeof args['from'] === 'string' ? args['from'].toLowerCase() : undefined;
        const matching = from === undefined
          ? summaries
          : summaries.filter((summary) => (summary.from ?? '').toLowerCase().includes(from));
        return matching.slice(-(args['limit'] as number));
      }
      if (name === 'read_message') {
        const body = bodies[args['uid'] as number];
        if (!body) {
          throw new MailboxReaderError('mailbox_unavailable', 'tool_error');
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

    const messages = await reader.search({ sinceMs: T0 - 10 * 60_000, senderDomains: ['in-tendhost.co.uk'] });

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
      expect.objectContaining({ mailbox: 'INBOX', since: '2026-07-07', from: 'in-tendhost.co.uk' }),
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

    const messages = await reader.search({ sinceMs: T0 - 30 * 60_000, senderDomains: ['x.com'] });

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

    const messages = await reader.search({ sinceMs: T0 - 60_000, senderDomains: ['x.com'] });

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

    const messages = await reader.search({ sinceMs: T0 - 60_000, senderDomains: ['x.com'] });

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

    const messages = await reader.search({ sinceMs: T0 - 60_000, senderDomains: ['x.com'] });

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

  it('reads the code from an HTML-only British Council MyProcurement mail', async () => {
    // Shape of the real 2026-10-30 registration mail: empty text part, the code
    // alone in an <h1>, other numbers (validity, charity numbers) in prose.
    const html = '<p><img src="data:image/png;base64,iVBORw0KGgo"></p><p>Dear Supplier,</p>'
      + '<p>To complete your email verification for British Council MyProcurement, please enter the '
      + 'One-Time Password (OTP) provided below:</p><h1><strong>481516</strong></h1>'
      + '<p>This OTP is valid for 10 minutes.</p><p>A registered charity: 209131 (England and Wales) '
      + 'SC037733 (Scotland).</p>';
    const client = makeClient(
      [{
        uid: 31,
        from: 'noreplyProcurement <noreply.procurement@britishcouncil.org>',
        subject: 'British Council MyProcurement - Supplier Registration Email Verification OTP',
        date: new Date(T0 - 20_000).toISOString(),
        snippet: '',
      }],
      { 31: { text: '', html } },
    );
    const mailbox = new ImapMcpMailboxReader({ server: { command: 'node', args: [] }, client, now: () => T0 });
    const codeReader = new BrowserEmailCodeReader({ reader: mailbox, now: () => T0 });

    const result = await codeReader.fetchCode({
      expectedSenderDomains: ['tap.tcsapps.com', 'britishcouncil.org'],
      sinceMs: T0 - 10 * 60_000,
      withinMs: 10 * 60_000,
    });

    expect(result).toMatchObject({ code: '481516', messageId: '31' });
  });
});

describe('ImapMcpMailboxReader sender filtering', () => {
  const server = { command: 'node', args: [] };

  it('finds the code on a busy inbox without reading any unrelated mail', async () => {
    // The code mail is followed by 150 newer unrelated messages: an unfiltered
    // "newest N" search would never see it.
    const codeMail = {
      uid: 1,
      from: 'Report MI <report-mi@gca.gov.uk>',
      subject: 'Report MI sign in',
      date: new Date(T0 - 120_000).toISOString(),
    };
    const noise = Array.from({ length: 150 }, (_, i) => ({
      uid: i + 2,
      from: `offers${i}@shop.example`,
      subject: 'Offer',
      date: new Date(T0 - 100_000 + i * 500).toISOString(),
    }));
    const client = makeClient(
      [codeMail, ...noise],
      {
        1: { text: 'Your MFA code is: 604213' },
        ...Object.fromEntries(noise.map((mail) => [mail.uid, { text: 'Your code is 111111' }])),
      },
    );
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });
    const codeReader = new BrowserEmailCodeReader({ reader: mailbox, now: () => T0 });

    const result = await codeReader.fetchCode({
      expectedSenderDomains: ['gca.gov.uk'],
      sinceMs: T0 - 15 * 60_000,
      withinMs: 15 * 60_000,
    });

    expect(result).toMatchObject({ code: '604213', messageId: '1' });
    const readUids = client.callTool.mock.calls
      .filter(([name]) => name === 'read_message')
      .map(([, args]) => args['uid']);
    expect(readUids).toEqual([1]);
  });

  it('drops server-side substring matches from other domains before reading their bodies', async () => {
    const client = makeClient(
      [
        { uid: 1, from: 'x@notgca.gov.uk', date: new Date(T0 - 2_000).toISOString() },
        { uid: 2, from: 'gca.gov.uk team <spoof@evil.example>', date: new Date(T0 - 1_000).toISOString() },
      ],
      { 1: { text: 'code 111111' }, 2: { text: 'code 222222' } },
    );
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });

    const messages = await mailbox.search({ sinceMs: T0 - 60_000, senderDomains: ['gca.gov.uk'] });

    expect(messages).toEqual([]);
    expect(client.callTool.mock.calls.some(([name]) => name === 'read_message')).toBe(false);
  });

  it('searches each sender domain and merges the results newest first', async () => {
    const client = makeClient(
      [
        { uid: 1, from: 'a@gca.gov.uk', date: new Date(T0 - 2_000).toISOString() },
        { uid: 2, from: 'b@notifications.service.gov.uk', date: new Date(T0 - 1_000).toISOString() },
      ],
      { 1: { text: 'one' }, 2: { text: 'two' } },
    );
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });

    const messages = await mailbox.search({
      sinceMs: T0 - 60_000,
      senderDomains: ['GCA.gov.uk', 'notifications.service.gov.uk', 'gca.gov.uk'],
    });

    expect(messages.map((m) => m.id)).toEqual(['2', '1']);
    const searchedFrom = client.callTool.mock.calls
      .filter(([name]) => name === 'search_messages')
      .map(([, args]) => args['from']);
    expect(searchedFrom).toEqual(['gca.gov.uk', 'notifications.service.gov.uk']);
  });

  it('reads nothing when no sender domain is allowed', async () => {
    const client = makeClient([{ uid: 1, from: 'a@x.com', date: new Date(T0).toISOString() }]);
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });

    expect(await mailbox.search({ sinceMs: T0 - 60_000, senderDomains: [] })).toEqual([]);
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('stops with the mailbox failure instead of using the snippet when a body read times out', async () => {
    const client = {
      callTool: vi.fn(async (name: string) => {
        if (name === 'search_messages') {
          return [
            { uid: 1, from: 'a@x.com', date: new Date(T0 - 1_000).toISOString(), snippet: 'code 123456' },
            { uid: 2, from: 'a@x.com', date: new Date(T0 - 2_000).toISOString(), snippet: 'code 654321' },
          ];
        }
        throw new MailboxReaderError('mailbox_timeout', 'tools/call:read_message');
      }),
    };
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });

    await expect(mailbox.search({ sinceMs: T0 - 60_000, senderDomains: ['x.com'] }))
      .rejects.toMatchObject({ code: 'mailbox_timeout', detail: 'tools/call:read_message' });
    // One timed-out read is enough: the second message is not attempted.
    expect(client.callTool.mock.calls.filter(([name]) => name === 'read_message')).toHaveLength(1);
  });

  it('reports a malformed search result as the mailbox being unavailable', async () => {
    const client = { callTool: vi.fn(async () => ({ not: 'an array' })) };
    const mailbox = new ImapMcpMailboxReader({ server, client, now: () => T0 });

    await expect(mailbox.search({ sinceMs: T0 - 60_000, senderDomains: ['x.com'] }))
      .rejects.toMatchObject({ code: 'mailbox_unavailable', detail: 'invalid_search_result' });
  });
});

/**
 * Real child processes against a tiny fake MCP server. These pin the
 * 2026-11 failure: packaged Harness runs with launchd's PATH, the configured
 * command is a bare `node`, and the spawn failed with ENOENT on every fill.
 */
describe('ImapMcpClient child process', () => {
  let dir: string;
  let serverPath: string;
  const clients: ImapMcpClient[] = [];
  const savedEnv = { PATH: process.env['PATH'], HOME: process.env['HOME'] };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'imap-mcp-client-spec-'));
    serverPath = join(dir, 'fake-imap-mcp.cjs');
    writeFileSync(serverPath, [
      "const readline = require('node:readline');",
      "const mode = process.argv[2] || 'ok';",
      'const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");',
      'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      '  const msg = JSON.parse(line);',
      '  if (typeof msg.id !== "number") return;',
      '  if (msg.method === "initialize") return reply(msg.id, { protocolVersion: "2024-11-05", capabilities: {} });',
      '  if (msg.method !== "tools/call") return;',
      '  if (mode === "hang-search" && msg.params.name === "search_messages") return;',
      '  reply(msg.id, { content: [{ type: "text", text: "[]" }] });',
      '});',
    ].join('\n'));
  });

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.dispose();
    }
    process.env['PATH'] = savedEnv.PATH;
    process.env['HOME'] = savedEnv.HOME;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const track = (client: ImapMcpClient): ImapMcpClient => {
    clients.push(client);
    return client;
  };

  it('reports a command that cannot be started as mailbox_unavailable with its errno', async () => {
    const client = track(new ImapMcpClient({ command: join(dir, 'no-such-command'), args: [] }));

    await expect(client.callTool('search_messages', {}))
      .rejects.toMatchObject({ name: 'MailboxReaderError', code: 'mailbox_unavailable', detail: 'process_error:ENOENT' });
  });

  it.skipIf(process.platform === 'win32')(
    'starts a bare command from the Harness tool PATH even when the app PATH is launchd\'s',
    async () => {
      const home = join(dir, 'home');
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      const launcher = join(home, '.local', 'bin', 'fake-imap-mcp');
      writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${serverPath}" "$@"\n`);
      chmodSync(launcher, 0o755);
      process.env['HOME'] = home;
      process.env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
      const client = track(new ImapMcpClient({ command: 'fake-imap-mcp', args: [] }));

      await expect(client.callTool('search_messages', {})).resolves.toEqual([]);
    },
  );

  it('reports a request the server never answers as mailbox_timeout naming the tool', async () => {
    const client = track(new ImapMcpClient({ command: process.execPath, args: [serverPath, 'hang-search'] }, 2_000));
    // Answered: proves the server started, so the timeout below is the search.
    await expect(client.callTool('read_message', {})).resolves.toEqual([]);

    await expect(client.callTool('search_messages', {}))
      .rejects.toMatchObject({ code: 'mailbox_timeout', detail: 'tools/call:search_messages' });
  }, 20_000);
});
