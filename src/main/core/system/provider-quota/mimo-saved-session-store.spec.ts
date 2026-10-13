import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SafeStorageAccessor } from '../../../session/safe-storage-accessor';
import { MimoSavedSessionStore, type MimoSavedCookie } from './mimo-saved-session-store';

// Deterministic encryption for tests only, never an actual credential/key.
const safeStorage: SafeStorageAccessor = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => {
    const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12, 2));
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  },
  decryptString: (ciphertext) => {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), Buffer.alloc(12, 2));
    decipher.setAuthTag(ciphertext.subarray(-16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
  },
};

function consoleCookies(): MimoSavedCookie[] {
  return [
    { name: 'api-platform_serviceToken', domain: '.platform.xiaomimimo.com', value: 'PLACEHOLDER_SERVICE' },
    { name: 'api-platform_slh', domain: '.platform.xiaomimimo.com', value: 'PLACEHOLDER_SLH' },
    { name: 'api-platform_ph', domain: '.platform.xiaomimimo.com', value: 'PLACEHOLDER_PH' },
    { name: 'userId', domain: '.xiaomimimo.com', value: 'PLACEHOLDER_USER' },
  ];
}

const header = 'api-platform_serviceToken=PLACEHOLDER_SERVICE; api-platform_slh=PLACEHOLDER_SLH; api-platform_ph=PLACEHOLDER_PH; userId=PLACEHOLDER_USER';

describe('MimoSavedSessionStore', () => {
  let dir: string;
  let rootDir: string;
  let now: number;
  let store: MimoSavedSessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-mimo-store-test-'));
    rootDir = join(dir, 'sessions');
    now = 1_000_000;
    store = new MimoSavedSessionStore({ rootDir, safeStorage, now: () => now });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('encrypts a complete session durably with owner-only permissions', () => {
    store.save('legacy', consoleCookies());
    const file = join(rootDir, readdirSync(rootDir)[0]);
    expect(readFileSync(file).includes(Buffer.from('PLACEHOLDER_SERVICE'))).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    const reopened = new MimoSavedSessionStore({ rootDir, safeStorage });
    expect(reopened.read('legacy')).toEqual({ session: { cookieHeader: header, userId: 'PLACEHOLDER_USER' } });
    expect(reopened.has('legacy')).toBe(true);
    expect(reopened.exists('legacy')).toBe(true);
  });

  it('returns not-found for an account without a saved record', () => {
    expect(store.read('spare')).toEqual({ session: null, reason: 'not-found' });
    expect(store.exists('spare')).toBe(false);
    expect(store.has('spare')).toBe(false);
  });

  it('omits expired cookies but keeps SSO usable when the console expires', () => {
    store.save('spare', [
      ...consoleCookies().map((cookie) => ({ ...cookie, expirationDate: 1100 })),
      { name: 'passToken', domain: 'account.xiaomi.com', value: 'PLACEHOLDER_SSO', expirationDate: 1200 },
    ]);
    now = 1_100_000;
    expect(store.read('spare')).toEqual({ session: null, reason: 'malformed' });
    expect(store.has('spare')).toBe(false);
    expect(store.exists('spare')).toBe(true);
    expect(store.readAccountSso('spare')).toEqual({ cookieHeader: 'passToken=PLACEHOLDER_SSO' });
    now = 1_200_000;
    expect(store.readAccountSso('spare')).toEqual({ cookieHeader: '' });
  });

  it('prefers account-host SSO values and never sends console cookies to SSO', () => {
    store.save('spare', [
      ...consoleCookies(),
      { name: 'cUserId', domain: '.xiaomi.com', value: 'PLACEHOLDER_PARENT' },
      { name: 'cUserId', domain: 'account.xiaomi.com', value: 'PLACEHOLDER_ACCOUNT' },
    ]);
    expect(store.readAccountSso('spare')).toEqual({ cookieHeader: 'cUserId=PLACEHOLDER_ACCOUNT' });
  });

  it('fails closed when encryption is unavailable or uses the plaintext Linux backend', () => {
    for (const unavailable of [
      { ...safeStorage, isEncryptionAvailable: () => false },
      { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' },
    ]) {
      const locked = new MimoSavedSessionStore({ rootDir, safeStorage: unavailable });
      expect(() => locked.assertEncryptionAvailable()).toThrow(/secure storage/i);
      expect(() => locked.save('spare', consoleCookies())).toThrow(/secure storage/i);
      expect(existsSync(rootDir)).toBe(false);
    }
    store.save('spare', consoleCookies());
    const locked = new MimoSavedSessionStore({ rootDir, safeStorage: { ...safeStorage, isEncryptionAvailable: () => false } });
    expect(locked.read('spare')).toEqual({ session: null, reason: 'denied' });
    expect(locked.readAccountSso('spare')).toEqual({ cookieHeader: '' });
  });

  it('checks secure storage before creating any directory or accessing a login', () => {
    expect(() => store.assertEncryptionAvailable()).not.toThrow();
    expect(existsSync(rootDir)).toBe(false);
  });

  it('rejects traversal and unsafe profile ids without touching disk', () => {
    for (const id of ['../spare', 'a/b', 'a\\b', '', '.', 'UPPER', 'a'.repeat(64)]) {
      expect(() => store.save(id, consoleCookies())).toThrow(/profile/i);
      expect(store.read(id)).toEqual({ session: null, reason: 'malformed' });
      expect(() => store.remove(id)).toThrow(/profile/i);
      expect(store.exists(id)).toBe(false);
    }
    expect(existsSync(rootDir)).toBe(false);
  });

  it('rejects incomplete, injected, mis-scoped, duplicate and oversized cookie payloads', () => {
    const bad = [
      consoleCookies().slice(1),
      [{ ...consoleCookies()[0], value: 'PLACEHOLDER; injected=VALUE' }, ...consoleCookies().slice(1)],
      [{ ...consoleCookies()[0], value: 'PLACEHOLDER\r\nHEADER' }, ...consoleCookies().slice(1)],
      [{ ...consoleCookies()[0], domain: '.evil.example' }, ...consoleCookies().slice(1)],
      [{ ...consoleCookies()[0], value: 'X'.repeat(8193) }, ...consoleCookies().slice(1)],
      [...consoleCookies(), consoleCookies()[0]],
      [{ ...consoleCookies()[0], expirationDate: NaN }, ...consoleCookies().slice(1)],
      [{ ...consoleCookies()[0], expirationDate: 999 }, ...consoleCookies().slice(1)],
      Array.from({ length: 11 }, () => consoleCookies()[0]),
    ];
    for (const cookies of bad) expect(() => store.save('spare', cookies)).toThrow(/session/i);
    expect(existsSync(rootDir)).toBe(false);
  });

  it('returns a typed failure for corrupt data without returning or logging decrypted input', () => {
    store.save('spare', consoleCookies());
    const file = join(rootDir, readdirSync(rootDir)[0]);
    writeFileSync(file, 'PLACEHOLDER_CORRUPT');
    expect(store.read('spare')).toEqual({ session: null, reason: 'malformed' });
    expect(store.readAccountSso('spare')).toEqual({ cookieHeader: '' });
    expect(store.exists('spare')).toBe(true);
  });

  it('redacts decryption and encryption failures including the renewal path', () => {
    store.save('spare', consoleCookies());
    const broken = new MimoSavedSessionStore({ rootDir, safeStorage: {
      ...safeStorage,
      decryptString: () => { throw new Error('PLACEHOLDER_PRIVATE_ERROR'); },
      encryptString: () => { throw new Error('PLACEHOLDER_PRIVATE_ERROR'); },
    } });
    expect(broken.read('spare')).toEqual({ session: null, reason: 'malformed' });
    expect(() => broken.save('spare', consoleCookies())).toThrow('MiMo saved session could not be stored or read safely.');
    expect(() => broken.saveRenewed('spare', { cookieHeader: header, userId: 'PLACEHOLDER_USER' }, 0)).toThrow('MiMo saved session could not be stored or read safely.');
  });

  it('refuses symlinked directories and session files', () => {
    symlinkSync(dir, rootDir, 'dir');
    expect(() => store.save('spare', consoleCookies())).toThrow(/session/i);
    expect(store.read('spare')).toEqual({ session: null, reason: 'malformed' });
    // An unsafe store must never select another account's Chrome login.
    expect(store.exists('spare')).toBe(true);
    rmSync(rootDir);
    store.save('spare', consoleCookies());
    const file = join(rootDir, readdirSync(rootDir)[0]);
    const target = join(dir, 'external');
    writeFileSync(target, 'PLACEHOLDER_EXTERNAL');
    rmSync(file);
    symlinkSync(target, file);
    expect(store.read('spare')).toEqual({ session: null, reason: 'malformed' });
    expect(() => store.save('spare', consoleCookies())).toThrow(/session/i);
    store.remove('spare');
    expect(readFileSync(target, 'utf8')).toBe('PLACEHOLDER_EXTERNAL');
  });

  it('persists renewed console cookies within the same generation while preserving SSO', () => {
    store.save('spare', [...consoleCookies(), { name: 'passToken', domain: 'account.xiaomi.com', value: 'PLACEHOLDER_SSO' }]);
    const generation = store.generation('spare');
    store.saveRenewed('spare', { cookieHeader: header.replace('PLACEHOLDER_SERVICE', 'PLACEHOLDER_RENEWED'), userId: 'PLACEHOLDER_USER' }, generation);
    expect(store.generation('spare')).toBe(generation);
    expect(store.read('spare').session?.cookieHeader).toContain('PLACEHOLDER_RENEWED');
    expect(store.readAccountSso('spare')).toEqual({ cookieHeader: 'passToken=PLACEHOLDER_SSO' });
  });

  it('never resurrects disconnected or replaced accounts from an old renewal', () => {
    const initial = store.generation('spare');
    store.save('spare', consoleCookies());
    expect(store.generation('spare')).toBe(initial + 1);
    const connected = store.generation('spare');
    store.remove('spare');
    expect(store.generation('spare')).toBe(connected + 1);
    store.saveRenewed('spare', { cookieHeader: header, userId: 'PLACEHOLDER_USER' }, connected);
    expect(store.exists('spare')).toBe(false);
    store.save('spare', consoleCookies());
    store.saveRenewed('spare', { cookieHeader: header.replace('PLACEHOLDER_SERVICE', 'PLACEHOLDER_STALE'), userId: 'PLACEHOLDER_USER' }, connected);
    expect(store.read('spare').session?.cookieHeader).toBe(header);
  });

  it('rejects malformed renewed headers and identity changes without damaging the saved session', () => {
    store.save('spare', consoleCookies());
    const generation = store.generation('spare');
    for (const cookieHeader of [`${header}; injected=PLACEHOLDER`, header.replace('PLACEHOLDER_SERVICE', 'PLACEHOLDER\nBAD'), header.replace('PLACEHOLDER_USER', 'OTHER_USER')]) {
      expect(() => store.saveRenewed('spare', { cookieHeader, userId: 'PLACEHOLDER_USER' }, generation)).toThrow(/session/i);
      expect(store.read('spare').session?.cookieHeader).toBe(header);
    }
  });
});
