/**
 * MimoConsoleCredentialsReader
 *
 * Reads the MiMo console session cookies from Chrome's cookie store so Harness
 * can call the console's read-only Token Plan quota endpoints
 * (`/api/v1/tokenPlan/usage` + `/detail`). The Token Plan API key is refused
 * there (401); these endpoints accept only the browser console session.
 *
 * Two stores are involved, both read-only:
 *
 *   1. Chrome's `Default/Cookies` SQLite DB holds the encrypted cookie values
 *      (hosts `.platform.xiaomimimo.com` and `.xiaomimimo.com` — exactly the
 *      cookies the console page itself sends).
 *   2. The macOS Keychain item `Chrome Safe Storage` / account `Chrome` holds
 *      the password the AES key derives from. Read through `/usr/bin/security`
 *      like the Cursor and Claude items; this reader never writes it.
 *
 * Cookie values are decrypted in memory and returned only to the probe's
 * quota fetch — never logged, never persisted. The cookies are browser-session
 * scoped (`is_persistent = 0` in Chrome's schema), so a missing set simply
 * means "sign in to the MiMo console again"; readers fail closed to a typed
 * reason, never to partial numbers.
 *
 * Cookie blob layout (verified against the live store this reads):
 * `b"v10" + 16-byte prefix + 16-byte IV + AES-128-CBC(PKCS#7)` with key
 * `PBKDF2-HMAC-SHA1(password, "saltysalt", 1003, 16)`.
 */

import { execFile as execFileCb } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('MimoConsoleCredentialsReader');

const KEYCHAIN_SERVICE = 'Chrome Safe Storage';
const KEYCHAIN_ACCOUNT = 'Chrome';
const DEFAULT_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND = 44;

/** The four cookies that make up one console request's session. */
const WANTED_COOKIES: ReadonlyArray<{ hostKey: string; name: string }> = [
  { hostKey: '.platform.xiaomimimo.com', name: 'api-platform_serviceToken' },
  { hostKey: '.platform.xiaomimimo.com', name: 'api-platform_slh' },
  { hostKey: '.platform.xiaomimimo.com', name: 'api-platform_ph' },
  { hostKey: '.xiaomimimo.com', name: 'userId' },
];

export interface MimoConsoleSession {
  /** Cookie header value: the three `api-platform_*` cookies plus `userId`. */
  cookieHeader: string;
  /** The Xiaomi account user id (also sent as the `userId` query parameter). */
  userId: string;
}

export type MimoCredentialFailureReason =
  | 'not-found'
  | 'denied'
  | 'malformed'
  | 'unsupported';

export interface MimoCredentialResult {
  session: MimoConsoleSession | null;
  reason?: MimoCredentialFailureReason;
}

export type MimoChromeSecurityExec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface MimoConsoleCredentialsReaderOptions {
  platform?: NodeJS.Platform;
  securityExec?: MimoChromeSecurityExec;
  /** Process env (used to resolve the Chrome data dir). */
  env?: NodeJS.ProcessEnv;
  /** Override the Chrome Cookies DB path (tests). */
  cookiesPath?: string;
  /** SQLite driver factory — defaults to the real better-sqlite3 driver. */
  driverFactory?: SqliteDriverFactory;
  /** File-existence check (tests). */
  fileExists?: (filePath: string) => boolean;
}

export class MimoConsoleCredentialsReader {
  private readonly platform: NodeJS.Platform;
  private readonly securityExec: MimoChromeSecurityExec;
  private readonly cookiesPath: string;
  private readonly driverFactory: SqliteDriverFactory;
  private readonly fileExists: (filePath: string) => boolean;

  constructor(opts: MimoConsoleCredentialsReaderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.cookiesPath = opts.cookiesPath ?? defaultChromeCookiesPath(this.platform, opts.env);
    this.driverFactory = opts.driverFactory ?? defaultDriverFactory;
    this.fileExists = opts.fileExists ?? existsSync;
  }

  async read(): Promise<MimoCredentialResult> {
    if (this.platform !== 'darwin') {
      // Chrome's cookie encryption (and the Safe Storage Keychain item) is a
      // macOS store; other platforms use different protection we do not read.
      return { session: null, reason: 'unsupported' };
    }
    const password = await this.readSafeStoragePassword();
    if (password === null) {
      return { session: null, reason: 'denied' };
    }
    if (password === undefined) {
      return { session: null, reason: 'not-found' };
    }
    return this.readCookies(password);
  }

  /**
   * The Chrome Safe Storage password. `null` = guarded/denied (an actionable
   * Keychain problem), `undefined` = the item simply is not there.
   */
  private async readSafeStoragePassword(): Promise<string | null | undefined> {
    try {
      const { stdout, exitCode } = await this.securityExec(
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      if (exitCode === KEYCHAIN_ITEM_NOT_FOUND) return undefined;
      if (exitCode !== 0) return null;
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch (err) {
      // A rejected/timed-out guarded read surfaces as an error from the exec.
      logger.debug(`Chrome Safe Storage read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private readCookies(password: string): MimoCredentialResult {
    if (!this.fileExists(this.cookiesPath)) {
      return { session: null, reason: 'not-found' };
    }

    let driver: SqliteDriver | null = null;
    const values = new Map<string, string>();
    try {
      driver = this.driverFactory(this.cookiesPath, { readonly: true });
      // Parameterised per pair would mean four round-trips; one bounded IN
      // query over constants is fine and keeps the read single-shot.
      const wanted = WANTED_COOKIES.map((entry) => `('${entry.hostKey}', '${entry.name}')`).join(', ');
      const rows = driver
        .prepare(
          `SELECT host_key, name, encrypted_value FROM cookies
           WHERE (host_key, name) IN (${wanted}) AND encrypted_value != ''`,
        )
        .all<{ host_key?: unknown; name?: unknown; encrypted_value?: unknown }>();
      for (const row of rows) {
        const name = typeof row.name === 'string' ? row.name : '';
        const blob = toBuffer(row.encrypted_value);
        const plain = blob ? decryptChromeV10(password, blob) : null;
        if (!plain) continue;
        // Some values are stored DQUOTE-wrapped (RFC 6265 cookie quoting); the
        // console accepts the bare token and so do we. Printable ASCII only —
        // anything else means the decrypt was wrong and the value is garbage.
        const text = plain.toString('utf8').trim().replace(/^"+|"+$/g, '');
        if (text && /^[\x20-\x7E]+$/.test(text)) values.set(name, text);
      }
    } catch (err) {
      logger.debug(`Chrome cookie read failed: ${(err as Error).message}`);
      return { session: null, reason: 'not-found' };
    } finally {
      try {
        driver?.close();
      } catch {
        /* best-effort close */
      }
    }

    const parts: string[] = [];
    for (const entry of WANTED_COOKIES) {
      const value = values.get(entry.name);
      if (!value) return { session: null, reason: 'malformed' };
      parts.push(`${entry.name}=${value}`);
    }
    return {
      session: { cookieHeader: parts.join('; '), userId: values.get('userId') as string },
    };
  }
}

/**
 * Chrome v10 cookie value → plaintext, or null when the blob is not a v10
 * value or fails to decrypt (wrong password, unexpected layout).
 *
 * Node's decipher unpads PKCS#7 in `final()` already — do not strip again.
 */
export function decryptChromeV10(password: string, blob: Buffer): Buffer | null {
  if (blob.length < 3 + 48 || blob.subarray(0, 3).toString('latin1') !== 'v10') {
    return null;
  }
  const body = blob.subarray(3);
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, body.subarray(16, 32));
    return Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]);
  } catch {
    // Node validates PKCS#7 in final(): a wrong key/layout lands here.
    return null;
  }
}

/**
 * Resolve the platform-specific path to Chrome's cookie store. Chrome's
 * profile layout is the standard Chromium one (`Default` profile).
 */
export function defaultChromeCookiesPath(
  platform: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): string {
  const home = (env && env['HOME']) || os.homedir();
  if (platform === 'darwin') {
    return path.posix.join(
      home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Cookies');
  }
  if (platform === 'win32') {
    const appData = (env && env['APPDATA']) || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Google', 'Chrome', 'User Data', 'Default', 'Cookies');
  }
  return path.posix.join(home, '.config', 'google-chrome', 'Default', 'Cookies');
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value.length > 0 ? value : null;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value.length > 0) return Buffer.from(value, 'latin1');
  return null;
}

const defaultSecurityExec: MimoChromeSecurityExec = (args, { timeoutMs }) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFileCb(
      '/usr/bin/security',
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === 'string') return reject(err);
          resolve({
            stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : 1,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
