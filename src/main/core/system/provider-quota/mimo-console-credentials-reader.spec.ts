import { describe, it, expect } from 'vitest';
import { createCipheriv, pbkdf2Sync } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MimoConsoleCredentialsReader,
  decryptChromeV10,
  defaultChromeCookiesPath,
  snapshotChromeCookiesDb,
  type MimoChromeSecurityExec,
} from './mimo-console-credentials-reader';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';

const PASSWORD = 'unit-test-password';

// Chrome v10 cookie blob for PASSWORD decrypting to "web". Layout fixture
// (prefix ff..00 | iv 00..ff | AES-128-CBC-PKCS7 ct), not a credential.
const KNOWN_BLOB_HEX =
  '763130ffeeddccbbaa99887766554433221100' +
  '00112233445566778899aabbccddeeff' +
  '576ae7178dc6a402c0dc0ded5085cee7';

/** Build a v10 blob the way Chrome stores one (for row-assembly tests). */
function chromeBlob(password: string, plaintext: string | Buffer): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const prefix = Buffer.alloc(16, 3);
  const iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const ct = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), prefix, iv, ct]);
}

function keychainExec(result: { stdout?: string; exitCode?: number; throws?: Error }): MimoChromeSecurityExec {
  return async () => {
    if (result.throws) throw result.throws;
    return { stdout: result.stdout ?? '', stderr: '', exitCode: result.exitCode ?? 0 };
  };
}

interface FakeRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
}

interface FakeDriverProbe {
  sqls: string[];
  options: unknown[];
}

/** Fake driver factory returning the given cookie rows and recording its use. */
function cookiesFactory(rows: FakeRow[]): {
  factory: SqliteDriverFactory;
  probe: FakeDriverProbe;
} {
  const probe: FakeDriverProbe = { sqls: [], options: [] };
  const driver: SqliteDriver = {
    prepare: (sql: string) => {
      probe.sqls.push(sql);
      return {
        get: () => undefined,
        all: () => rows as never,
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    prepareCached: () => driver.prepare(''),
    exec() {},
    pragma: () => undefined,
    transaction: (fn: (...args: unknown[]) => unknown) => fn,
    backup() {},
    close() {},
  } as unknown as SqliteDriver;
  const factory: SqliteDriverFactory = (_path, options) => {
    probe.options.push(options);
    return driver;
  };
  return { factory, probe };
}

function fullRows(password = PASSWORD): FakeRow[] {
  return [
    { host_key: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', encrypted_value: chromeBlob(password, 'token-abc') },
    { host_key: '.platform.xiaomimimo.com', name: 'api-platform_slh', encrypted_value: chromeBlob(password, 'slh-abc') },
    // DQUOTE-wrapped, as some of the console's own cookies are stored.
    { host_key: '.platform.xiaomimimo.com', name: 'api-platform_ph', encrypted_value: chromeBlob(password, '"ph-abc"') },
    { host_key: '.xiaomimimo.com', name: 'userId', encrypted_value: chromeBlob(password, 'test-user-id') },
  ];
}

const base = {
  platform: 'darwin' as const,
  securityExec: keychainExec({ stdout: PASSWORD }),
  cookiesPath: '/tmp/chrome-cookies',
  fileExists: () => true,
};

describe('decryptChromeV10', () => {
  it('decrypts the known-answer vector', () => {
    const plain = decryptChromeV10(PASSWORD, Buffer.from(KNOWN_BLOB_HEX, 'hex'));
    expect(plain?.toString('utf8')).toBe('web');
  });

  it('does not strip plaintext whose trailing bytes look like padding', () => {
    // Node's decipher already unpads in final(); a second strip keyed on the
    // last plaintext byte silently corrupts values ending in 0x01-0x10.
    const body = Buffer.from([0x69, 0x64, 0x01, 0x02]); // b"id\x01\x02"
    const plain = decryptChromeV10(PASSWORD, chromeBlob(PASSWORD, body));
    expect(plain?.equals(body)).toBe(true);
  });

  it('rejects non-v10 and truncated blobs', () => {
    expect(decryptChromeV10('x', Buffer.from('v20short'))).toBeNull();
    expect(decryptChromeV10('x', Buffer.from('v10'))).toBeNull();
    expect(decryptChromeV10('x', Buffer.from('not a blob'))).toBeNull();
  });

  it('rejects a wrong password instead of returning garbage', () => {
    expect(decryptChromeV10('wrong-password', Buffer.from(KNOWN_BLOB_HEX, 'hex'))).toBeNull();
  });
});

describe('MimoConsoleCredentialsReader', () => {
  it('assembles the console session cookies and userId', async () => {
    const { factory } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({ ...base, driverFactory: factory });

    const { session, reason } = await reader.read();

    expect(reason).toBeUndefined();
    expect(session!.userId).toBe('test-user-id');
    expect(session!.cookieHeader).toBe(
      'api-platform_serviceToken=token-abc; api-platform_slh=slh-abc; api-platform_ph=ph-abc; userId=test-user-id',
    );
  });

  it('opens the cookie store read-only and scopes the query to the console cookies', async () => {
    const { factory, probe } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({ ...base, driverFactory: factory });

    await reader.read();

    expect(probe.options).toEqual([{ readonly: true }]);
    const sql = probe.sqls.join('\n');
    expect(sql).toContain("('.platform.xiaomimimo.com', 'api-platform_serviceToken')");
    expect(sql).toContain("('.platform.xiaomimimo.com', 'api-platform_slh')");
    expect(sql).toContain("('.platform.xiaomimimo.com', 'api-platform_ph')");
    expect(sql).toContain("('.xiaomimimo.com', 'userId')");
    expect(sql).toContain("encrypted_value != ''");
  });

  it('reads the Chrome Safe Storage item with the read-only keychain args', async () => {
    const calls: string[][] = [];
    const { factory } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      securityExec: async (args) => {
        calls.push(args);
        return { stdout: PASSWORD, stderr: '', exitCode: 0 };
      },
      driverFactory: factory,
    });

    await reader.read();

    expect(calls[0]).toEqual([
      'find-generic-password',
      '-s',
      'Chrome Safe Storage',
      '-a',
      'Chrome',
      '-w',
    ]);
  });

  it('reports malformed when any session cookie is missing', async () => {
    const { factory } = cookiesFactory(fullRows().slice(0, 3));
    const reader = new MimoConsoleCredentialsReader({ ...base, driverFactory: factory });

    const { session, reason } = await reader.read();

    expect(session).toBeNull();
    expect(reason).toBe('malformed');
  });

  it('reports malformed when a value fails to decrypt', async () => {
    const rows = fullRows().map((row, index) =>
      index === 0 ? { ...row, encrypted_value: chromeBlob('wrong-password', 'junk') } : row);
    const { factory } = cookiesFactory(rows);
    const reader = new MimoConsoleCredentialsReader({ ...base, driverFactory: factory });

    const { reason } = await reader.read();

    expect(reason).toBe('malformed');
  });

  it('reports denied when the keychain read is guarded', async () => {
    const { factory } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      securityExec: keychainExec({ exitCode: 1 }),
      driverFactory: factory,
    });

    const { session, reason } = await reader.read();

    expect(session).toBeNull();
    expect(reason).toBe('denied');
  });

  it('reports denied when the keychain read throws', async () => {
    const { factory } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      securityExec: keychainExec({ throws: new Error('prompt timed out') }),
      driverFactory: factory,
    });

    const { reason } = await reader.read();

    expect(reason).toBe('denied');
  });

  it('reports not-found when the keychain item is absent (no Chrome)', async () => {
    const { factory } = cookiesFactory(fullRows());
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      securityExec: keychainExec({ exitCode: 44 }),
      driverFactory: factory,
    });

    const { reason } = await reader.read();

    expect(reason).toBe('not-found');
  });

  it('reports not-found when the cookie store is absent', async () => {
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      fileExists: () => false,
    });

    const { reason } = await reader.read();

    expect(reason).toBe('not-found');
  });

  it('is unsupported off macOS (different cookie protection)', async () => {
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      platform: 'linux',
    });

    const { session, reason } = await reader.read();

    expect(session).toBeNull();
    expect(reason).toBe('unsupported');
  });

  it('resolves the standard Chrome cookies path per platform', () => {
    expect(defaultChromeCookiesPath('darwin', { HOME: '/h' })).toBe(
      '/h/Library/Application Support/Google/Chrome/Default/Cookies');
    expect(defaultChromeCookiesPath('win32', { HOME: 'C:\\h', APPDATA: 'C:\\a' })).toContain(
      'Google');
  });

  it('falls back to a snapshot copy when the live store is locked', async () => {
    // Regression: Chrome holds the live Cookies store often enough that the
    // direct read fails with OperationalError. The snapshot is opened
    // read-write (a copied hot journal needs recovery), the live store
    // read-only.
    const { factory, probe } = cookiesFactory(fullRows());
    let calls = 0;
    const throwingFactory: SqliteDriverFactory = (path, options) => {
      calls += 1;
      if (calls === 1) throw new Error('database is locked');
      return factory(path, options);
    };
    const snapshots: string[] = [];
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      driverFactory: throwingFactory,
      takeDbSnapshot: (cookiesPath) => {
        snapshots.push(cookiesPath);
        return '/tmp/snapshot-cookies';
      },
    });

    const { session } = await reader.read();

    expect(calls).toBe(2);
    expect(snapshots).toEqual(['/tmp/chrome-cookies']);
    expect(session?.userId).toBe('test-user-id');
    expect(probe.options).toEqual([{ readonly: false }]);
  });

  it('reads Xiaomi account SSO cookies best-effort for the renewal walk', async () => {
    const rows: FakeRow[] = [
      { host_key: 'account.xiaomi.com', name: 'passToken', encrypted_value: chromeBlob(PASSWORD, 'sso-pass') },
      { host_key: 'account.xiaomi.com', name: 'cUserId', encrypted_value: chromeBlob(PASSWORD, 'account-cuser') },
      { host_key: '.xiaomi.com', name: 'cUserId', encrypted_value: chromeBlob(PASSWORD, 'dot-cuser') },
      // Console cookie — never part of the SSO header.
      { host_key: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken', encrypted_value: chromeBlob(PASSWORD, 'console-token') },
    ];
    const { factory } = cookiesFactory(rows);
    const reader = new MimoConsoleCredentialsReader({ ...base, driverFactory: factory });

    const { cookieHeader } = await reader.readAccountSso();

    // Missing SSO cookies (userId, deviceId, pass_ua) are fine — the walk is
    // best-effort. The account host wins the duplicate cUserId; the console
    // cookie is excluded.
    expect(cookieHeader).toBe('cUserId=account-cuser; passToken=sso-pass');
  });

  it('returns an empty SSO header rather than throwing when the store is unreadable', async () => {
    const throwingFactory: SqliteDriverFactory = () => {
      throw new Error('database is locked');
    };
    const reader = new MimoConsoleCredentialsReader({
      ...base,
      driverFactory: throwingFactory,
      takeDbSnapshot: () => null,
    });

    await expect(reader.readAccountSso()).resolves.toEqual({ cookieHeader: '' });
  });
});

describe('snapshotChromeCookiesDb', () => {
  it('copies the store and its rollback journal into a temp snapshot', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harness-mimo-test-'));
    const source = path.join(dir, 'Cookies');
    writeFileSync(source, 'db-bytes');
    writeFileSync(`${source}-journal`, 'journal-bytes');

    try {
      const snapshot = snapshotChromeCookiesDb(source);
      expect(snapshot).toBeTruthy();
      expect(readFileSync(snapshot!, 'utf8')).toBe('db-bytes');
      expect(readFileSync(`${snapshot}-journal`, 'utf8')).toBe('journal-bytes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when the store does not exist', () => {
    expect(snapshotChromeCookiesDb('/nonexistent/chrome/Cookies')).toBeNull();
  });
});
