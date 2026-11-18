import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./monitor-mail.js', import.meta.url));
const address = 'example@communitytech.co.uk';
const alert = { id: 'monitor-test', subject: 'Monitor test', text: 'Monitor test body.' };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aio-monitor-mail-'));
  directories.push(directory);
  const bundle = join(directory, 'imap-mcp-server');
  const dist = join(bundle, 'dist');
  const composer = join(bundle, 'node_modules', 'nodemailer');
  mkdirSync(dist, { recursive: true, mode: 0o700 });
  mkdirSync(join(composer, 'lib'), { recursive: true, mode: 0o700 });
  const config = join(directory, 'monitor-mail.json');
  const sender = {
    address, tenantId: '00000000-0000-0000-0000-000000000001',
    clientId: '00000000-0000-0000-0000-000000000002',
    certThumbprint: '0'.repeat(40), privateKeyFile: 'fixture.pem',
  };
  writeFileSync(config, JSON.stringify(sender), { mode: 0o600 });
  writeFileSync(join(directory, 'fixture.pem'), 'TEST_PLACEHOLDER', { mode: 0o600 });
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}');
  writeFileSync(join(composer, 'package.json'), '{"type":"commonjs","main":"lib/nodemailer.js"}');
  writeFileSync(join(composer, 'lib', 'nodemailer.js'), `
    exports.createTransport = options => {
      if (!options.streamTransport || !options.buffer) throw Error('Expected an offline composer');
      return { sendMail: async mail => ({ message: Buffer.from(JSON.stringify(mail)) }) };
    };
  `);
  writeFileSync(join(dist, 'm365-token.js'), `
    export class M365CertificateTokenProvider {
      async token() { return { value: 'TEST_PLACEHOLDER' }; }
    }
  `);
  writeFileSync(join(dist, 'm365-smtp.js'), `
    import { appendFileSync, readFileSync } from 'node:fs';
    const seen = new URL('../../send.log', import.meta.url);
    const mode = new URL('../../send-mode', import.meta.url);
    export async function runM365SmtpSession(options, action) {
      const message = JSON.parse(action.raw.toString());
      appendFileSync(seen, JSON.stringify({ options: { host: options.host, requireTLS: options.requireTLS },
        envelope: action.envelope, message }) + '\\n');
      switch (readFileSync(mode, 'utf8')) {
        case 'refuse': throw Object.assign(Error('TEST_DETAIL'), { endOfDataSent: false });
        case 'reject-data': throw Object.assign(Error('TEST_DETAIL'), { endOfDataSent: true, code: 'EMESSAGE', responseCode: 451 });
        case 'truncated-reply': throw Object.assign(Error('TEST_DETAIL'), { endOfDataSent: true, code: 'ECONNECTION', responseCode: 451 });
        case 'uncertain': throw Object.assign(Error('TEST_DETAIL'), { endOfDataSent: true });
        case 'crash': process.exit(86); break;
        case 'wait': await new Promise(resolve => setTimeout(resolve, 1000)); break;
      }
      return { accepted: action.envelope.to, rejected: [] };
    }
  `);
  writeFileSync(join(dist, 'imap-client.js'), `
    import { existsSync, readFileSync } from 'node:fs';
    const exactMatch = new URL('../../sent-message-id', import.meta.url);
    export class ImapClient {
      async findSentByMessageId(id) {
        return { found: existsSync(exactMatch) && readFileSync(exactMatch, 'utf8') === id };
      }
    }
  `);
  const setMode = (mode: string) => writeFileSync(join(directory, 'send-mode'), mode);
  setMode('accept');
  const args = [script, '--config', config];
  return {
    directory,
    setMode,
    updateSender: (overrides: object) => writeFileSync(config, JSON.stringify({ ...sender, ...overrides })),
    setSentMatch: (id: string) => writeFileSync(join(directory, 'sent-message-id'), id),
    sent: () => {
      const file = join(directory, 'send.log');
      return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
    check: (input = JSON.stringify(alert)) =>
      spawnSync(process.execPath, args, { input, encoding: 'utf8', timeout: 4_000 }),
    start: () => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.stdin.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(alert));
    }),
  };
}

describe('home-base Microsoft 365 sender', () => {
  it('submits to the configured inbox and remembers a success between command invocations', () => {
    const route = fixture();
    expect(route.check().status).toBe(0);
    expect(route.check().status).toBe(0);
    expect(route.sent()).toEqual([{
      options: { host: 'smtp.office365.com', requireTLS: true },
      envelope: { from: address, to: [address] },
      message: { from: address, to: address, subject: alert.subject, text: alert.text,
        messageId: expect.stringMatching(/^<home-base-monitor\.[0-9a-f]+@communitytech\.co\.uk>$/) },
    }]);
  });

  it.each(['refuse', 'reject-data'])('retries a definite refusal (%s) with the same message ID', mode => {
    const route = fixture();
    route.setMode(mode);
    const first = route.check();
    expect(first.status).toBe(1);
    expect(first.stderr).not.toContain('TEST_DETAIL');
    route.setMode('accept');
    expect(route.check().status).toBe(0);
    const attempts = route.sent();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].message.messageId).toBe(attempts[0].message.messageId);
  });

  it.each(['uncertain', 'truncated-reply', 'crash'])('resolves an ambiguous attempt (%s) only from the exact Sent Items match', mode => {
    const route = fixture();
    route.setMode(mode);
    expect(route.check().status).toBe(mode === 'crash' ? 86 : 1);
    const messageId = route.sent()[0].message.messageId;
    route.setMode('accept');
    route.setSentMatch(`${messageId}.similar`);
    expect(route.check().status).toBe(1);
    expect(route.sent()).toHaveLength(1);
    route.setSentMatch(messageId);
    expect(route.check().status).toBe(0);
    route.setSentMatch('removed-from-sent');
    expect(route.check().status).toBe(0);
    expect(route.sent()).toHaveLength(1);
  });

  it('allows only one of two simultaneous invocations to submit the same alert', async () => {
    const route = fixture();
    route.setMode('wait');
    expect(await Promise.all([route.start(), route.start()])).toContain(0);
    expect(route.sent()).toHaveLength(1);
    expect(route.check().status).toBe(0);
  });

  it('refuses additional objects, recipient overrides and invalid private configuration', () => {
    const route = fixture();
    expect(route.check(`${JSON.stringify(alert)}\n{}`).status).toBe(1);
    expect(route.check(JSON.stringify({ ...alert, to: 'other@example.invalid' })).status).toBe(1);
    route.updateSender({ address: 'example@communitytech.co.uk,other@example.invalid' });
    expect(route.check().status).toBe(1);
    expect(route.sent()).toHaveLength(0);
  });

  it.each([
    ['imap-mcp-server', 'dist/m365-smtp.js'],
    ['imap-mcp-server/dist', 'm365-smtp.js'],
    ['imap-mcp-server/dist/m365-smtp.js', ''],
    ['imap-mcp-server/node_modules/nodemailer/lib', 'nodemailer.js'],
    ['imap-mcp-server/node_modules/nodemailer/lib/nodemailer.js', ''],
  ])('refuses to load redirected mail code at %s', (relativePath, entry) => {
    const route = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'aio-monitor-mail-outside-'));
    directories.push(outside);
    const selected = join(route.directory, relativePath);
    const moved = join(outside, 'moved.js');
    const marker = join(outside, 'loaded');
    renameSync(selected, moved);
    writeFileSync(entry ? join(moved, entry) : moved,
      `process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
    symlinkSync(moved, selected, entry ? 'junction' : 'file');
    expect(route.check().status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(route.sent()).toHaveLength(0);
  });

  it.each([
    ['dist/m365-smtp.js', (file: string) => `import ${JSON.stringify(pathToFileURL(file).href)};`],
    ['node_modules/nodemailer/lib/nodemailer.js', (file: string) => `require(${JSON.stringify(file)});`],
  ] as const)('refuses a dependency requested from outside the bundle by %s', (relativePath, load) => {
    const route = fixture();
    const externalFile = join(route.directory, 'external.js');
    const marker = join(route.directory, 'loaded');
    writeFileSync(externalFile, `process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
    appendFileSync(join(route.directory, 'imap-mcp-server', relativePath), `\n${load(externalFile)}\n`);
    expect(route.check().status).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(route.sent()).toHaveLength(0);
  });
});
