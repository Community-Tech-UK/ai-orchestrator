import { randomUUID } from 'crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PROVIDER_ACCOUNT_PROFILE_ID_PATTERN } from '../../../../shared/types/provider-account.types';
import { getSafeStorage, type SafeStorageAccessor } from '../../../session/safe-storage-accessor';
import type { MimoConsoleSession, MimoCredentialResult } from './mimo-console-credentials-reader';

export interface MimoSavedCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
}

const CONSOLE_COOKIES = [
  ['.platform.xiaomimimo.com', 'api-platform_serviceToken'],
  ['.platform.xiaomimimo.com', 'api-platform_slh'],
  ['.platform.xiaomimimo.com', 'api-platform_ph'],
  ['.xiaomimimo.com', 'userId'],
] as const;
const SSO_COOKIES = [
  ['account.xiaomi.com', 'passToken'],
  ['account.xiaomi.com', 'cUserId'],
  ['account.xiaomi.com', 'userId'],
  ['account.xiaomi.com', 'deviceId'],
  ['account.xiaomi.com', 'pass_ua'],
  ['.xiaomi.com', 'cUserId'],
] as const;
const ALLOWED_PAIRS = new Set([...CONSOLE_COOKIES, ...SSO_COOKIES].map(([domain, name]) => `${domain}|${name}`));
const SSO_PAIRS = new Set(SSO_COOKIES.map(([domain, name]) => `${domain}|${name}`));
const MAX_FILE_BYTES = 128 * 1024;
const MAX_VALUE_BYTES = 8192;

/**
 * True for the exact account SSO pairs this store can persist (`domain` in its
 * stored form: `account.xiaomi.com` or `.xiaomi.com`). The renewal walk uses
 * this so rotated "refresh" cookies it hands back are always persistable, and
 * nothing else from a walk can reach the store.
 */
export function isPersistableMimoSsoCookie(domain: string, name: string): boolean {
  return SSO_PAIRS.has(`${domain}|${name}`);
}

export interface MimoSavedSessionStoreOptions {
  rootDir?: string;
  safeStorage?: SafeStorageAccessor;
  now?: () => number;
}

/** Durable login cookies, encrypted by the OS. No plaintext fallback or logging. */
export class MimoSavedSessionStore {
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private rootDir?: string;

  constructor(private readonly opts: MimoSavedSessionStoreOptions = {}) {
    this.rootDir = opts.rootDir;
    this.now = opts.now ?? Date.now;
  }

  read(profileId: string): MimoCredentialResult {
    try {
      const cookies = this.load(profileId);
      const session = this.consoleSession(cookies);
      return session ? { session } : { session: null, reason: 'malformed' };
    } catch (error) {
      return { session: null, reason: failureReason(error) };
    }
  }

  readAccountSso(profileId: string): { cookieHeader: string } {
    try {
      const cookies = this.liveCookies(this.load(profileId));
      const byName = new Map<string, string>();
      // Account host wins cUserId when both exact allowed domains are present.
      for (const [domain, name] of [...SSO_COOKIES].reverse()) {
        const cookie = cookies.find((entry) => entry.domain === domain && entry.name === name);
        if (cookie) byName.set(name, cookie.value);
      }
      return { cookieHeader: [...byName].map(([name, value]) => `${name}=${value}`).join('; ') };
    } catch {
      return { cookieHeader: '' };
    }
  }

  has(profileId: string): boolean { return this.read(profileId).session !== null; }

  /** Check before opening a sign-in window so an unsavable login fails early. */
  assertEncryptionAvailable(): void { this.secureStorage(); }

  /** Presence without decryption distinguishes expired/corrupt saved logins. */
  exists(profileId: string): boolean {
    if (typeof profileId !== 'string' || !PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profileId)) return false;
    try {
      const file = this.filePath(profileId);
      this.checkRoot(false);
      lstatSync(file);
      return true;
    } catch (error) {
      // Unreadable/unsafe storage must not silently select Chrome credentials.
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }

  save(profileId: string, cookies: MimoSavedCookie[]): void {
    validateProfileId(profileId);
    const validated = validateCookies(cookies);
    const live = this.liveCookies(validated);
    if (!this.consoleSession(live)) throw invalidSession();
    this.persist(profileId, live);
    this.generations.set(profileId, this.generation(profileId) + 1);
  }

  remove(profileId: string): void {
    const file = this.filePath(profileId);
    // Invalidate in-flight refresh/capture even when unlink fails.
    this.generations.set(profileId, this.generation(profileId) + 1);
    try {
      this.checkRoot(false);
      // unlink removes a symlink itself and never touches its destination.
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalidSession();
    }
  }

  generation(profileId: string): number {
    validateProfileId(profileId);
    return this.generations.get(profileId) ?? 0;
  }

  /**
   * Persist a renewed console session (and, optionally, the account SSO
   * cookies the renewal walk rotated — the "refresh" half of the login).
   * Unpersistable pairs and unusable values are dropped rather than taking a
   * good console renewal down with them; everything kept is strictly validated.
   */
  saveRenewed(
    profileId: string,
    session: MimoConsoleSession,
    expectedGeneration: number,
    ssoUpdates: readonly Pick<MimoSavedCookie, 'domain' | 'name' | 'value'>[] = [],
  ): void {
    if (this.generation(profileId) !== expectedGeneration || !this.exists(profileId)) return;
    const cookies = this.load(profileId);
    const originalUser = cookies.find((cookie) => cookie.domain === '.xiaomimimo.com' && cookie.name === 'userId');
    if (session.userId !== originalUser?.value || typeof session.cookieHeader !== 'string') throw invalidSession();
    const parts = session.cookieHeader.split('; ');
    if (parts.length !== CONSOLE_COOKIES.length) throw invalidSession();
    const renewed = CONSOLE_COOKIES.map(([domain, name]) => {
      const prefix = `${name}=`;
      const part = parts.find((entry) => entry.startsWith(prefix));
      if (!part) throw invalidSession();
      const previous = cookies.find((cookie) => cookie.domain === domain && cookie.name === name);
      // The renewal API returns session cookies without an expiry date.
      return { domain, name, value: part.slice(prefix.length), path: previous?.path, secure: previous?.secure, httpOnly: previous?.httpOnly };
    });
    const rotatedSso = this.rotatedSsoUpdates(ssoUpdates);
    const replaced = new Set([
      ...CONSOLE_COOKIES.map(([domain, name]) => `${domain}|${name}`),
      ...rotatedSso.map((cookie) => `${cookie.domain}|${cookie.name}`),
    ]);
    const all = validateCookies([
      ...cookies.filter((cookie) => !replaced.has(`${cookie.domain}|${cookie.name}`)),
      ...renewed,
      ...rotatedSso,
    ]);
    if (this.consoleSession(all)?.userId !== session.userId) throw invalidSession();
    this.persist(profileId, this.liveCookies(all));
  }

  /** Last-wins per persisted SSO pair; anything else is dropped, never fatal. */
  private rotatedSsoUpdates(
    updates: readonly Pick<MimoSavedCookie, 'domain' | 'name' | 'value'>[],
  ): MimoSavedCookie[] {
    const byPair = new Map<string, MimoSavedCookie>();
    for (const update of updates) {
      if (!update || typeof update.domain !== 'string' || typeof update.name !== 'string') continue;
      if (!isPersistableMimoSsoCookie(update.domain, update.name)) continue;
      try {
        byPair.set(`${update.domain}|${update.name}`, validateCookies([update])[0]!);
      } catch {
        // A malformed rotation value must not discard a good console renewal.
      }
    }
    return [...byPair.values()];
  }

  private directory(): string {
    if (!this.rootDir) {
      // Resolve only when used, never at module load or singleton creation.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron');
      this.rootDir = join(app.getPath('userData'), 'mimo-usage-sessions');
    }
    return this.rootDir;
  }

  private filePath(profileId: string): string {
    validateProfileId(profileId);
    return join(this.directory(), `${profileId}.bin`);
  }

  private secureStorage(): SafeStorageAccessor {
    try {
      const storage = this.opts.safeStorage ?? getSafeStorage();
      const withBackend = storage as SafeStorageAccessor & { getSelectedStorageBackend?: () => string };
      if (!storage.isEncryptionAvailable() || withBackend.getSelectedStorageBackend?.() === 'basic_text') {
        throw new Error('Unavailable');
      }
      return storage;
    } catch {
      throw new StoreFailure('denied', 'MiMo secure storage is unavailable.');
    }
  }

  private checkRoot(create: boolean): void {
    const root = this.directory();
    if (create) {
      try { lstatSync(root); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(root, { recursive: true, mode: 0o700 });
      }
    }
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalidSession();
    if (create) chmodSync(root, 0o700);
  }

  private load(profileId: string): MimoSavedCookie[] {
    const file = this.filePath(profileId);
    this.checkRoot(false);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw invalidSession();
    const storage = this.secureStorage();
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw invalidSession();
      const plain = storage.decryptString(readFileSync(fd));
      if (Buffer.byteLength(plain) > MAX_FILE_BYTES) throw invalidSession();
      const parsed: unknown = JSON.parse(plain);
      if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('cookies' in parsed)) throw invalidSession();
      return validateCookies(parsed.cookies);
    } catch {
      // Decrypt/JSON errors can include plaintext snippets; never expose them.
      throw invalidSession();
    } finally { closeSync(fd); }
  }

  private liveCookies(cookies: MimoSavedCookie[]): MimoSavedCookie[] {
    return cookies.filter((cookie) => cookie.expirationDate === undefined || cookie.expirationDate * 1000 > this.now());
  }

  private consoleSession(cookies: MimoSavedCookie[]): MimoConsoleSession | null {
    const live = this.liveCookies(cookies);
    const values = CONSOLE_COOKIES.map(([domain, name]) => live.find((cookie) => cookie.domain === domain && cookie.name === name)?.value);
    if (values.some((value) => !value)) return null;
    return { cookieHeader: CONSOLE_COOKIES.map(([, name], index) => `${name}=${values[index]}`).join('; '), userId: values[3]! };
  }

  private persist(profileId: string, cookies: MimoSavedCookie[]): void {
    const storage = this.secureStorage();
    let temporary: string | undefined;
    try {
      const encrypted = storage.encryptString(JSON.stringify({ version: 1, cookies }));
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_FILE_BYTES) throw invalidSession();
      const file = this.filePath(profileId);
      this.checkRoot(true);
      try {
        const existing = lstatSync(file);
        if (!existing.isFile() || existing.isSymbolicLink()) throw invalidSession();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      temporary = join(this.directory(), `.${profileId}-${randomUUID()}.tmp`);
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      temporary = undefined;
    } catch {
      throw invalidSession();
    } finally {
      if (temporary) {
        try { unlinkSync(temporary); } catch { /* best-effort encrypted temp cleanup */ }
      }
    }
  }
}

function validateProfileId(profileId: string): void {
  if (typeof profileId !== 'string' || !PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(profileId)) {
    throw new StoreFailure('malformed', 'MiMo account profile is invalid.');
  }
}

function validateCookies(input: unknown): MimoSavedCookie[] {
  if (!Array.isArray(input) || input.length > ALLOWED_PAIRS.size) throw invalidSession();
  const seen = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw invalidSession();
    const cookie = item as MimoSavedCookie;
    if (typeof cookie.domain !== 'string' || typeof cookie.name !== 'string') throw invalidSession();
    const pair = `${cookie.domain}|${cookie.name}`;
    if (!ALLOWED_PAIRS.has(pair) || seen.has(pair)
      || typeof cookie.value !== 'string' || cookie.value.length === 0 || cookie.value.length > MAX_VALUE_BYTES
      // RFC 6265 cookie octets: excludes whitespace, quotes, comma, semicolon, backslash and control characters.
      || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(cookie.value)
      || (cookie.path !== undefined && (typeof cookie.path !== 'string' || cookie.path.length > 1024 || !cookie.path.startsWith('/') || !/^[\x20-\x3A\x3C-\x7E]+$/.test(cookie.path)))
      || (cookie.secure !== undefined && typeof cookie.secure !== 'boolean')
      || (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean')
      || (cookie.expirationDate !== undefined && (typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate) || cookie.expirationDate < 0))) throw invalidSession();
    seen.add(pair);
    return { name: cookie.name, value: cookie.value, domain: cookie.domain,
      ...(cookie.path !== undefined ? { path: cookie.path } : {}),
      ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
      ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
      ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}) };
  });
}

class StoreFailure extends Error {
  constructor(readonly reason: 'malformed' | 'denied', message: string) { super(message); }
}
function invalidSession(): StoreFailure { return new StoreFailure('malformed', 'MiMo saved session could not be stored or read safely.'); }
function failureReason(error: unknown): 'not-found' | 'malformed' | 'denied' {
  if (error instanceof StoreFailure) return error.reason;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' ? 'not-found' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'malformed';
}

let singleton: MimoSavedSessionStore | undefined;
export function getMimoSavedSessionStore(): MimoSavedSessionStore { return singleton ??= new MimoSavedSessionStore(); }
export function resetMimoSavedSessionStoreForTesting(): void { singleton = undefined; }
