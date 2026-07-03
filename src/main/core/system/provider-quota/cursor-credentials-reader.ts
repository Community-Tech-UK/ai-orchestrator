/**
 * CursorCredentialsReader
 *
 * Reads Cursor's dashboard session JWT so Harness can call Cursor's read-only
 * usage-summary endpoint without depending on the external token-usage-monitor.
 *
 * Two credential sources, tried in order:
 *
 *   1. The live desktop-app session token in Cursor's `state.vscdb`
 *      (`cursorAuth/accessToken`). This is the source of truth: the Cursor GUI
 *      refreshes it in place, so it tracks the signed-in account exactly.
 *
 *   2. The macOS Keychain item (`cursor-access-token` / `cursor-user`), written
 *      by the `cursor-agent` CLI. This is only a fallback — the CLI writes it at
 *      `cursor-agent login` time and does NOT keep it fresh, so it routinely goes
 *      stale (and expired) even while the user is fully signed in to the desktop
 *      app. Relying on it alone produced a false "session expired" reauth prompt.
 *
 * Read-only discipline: this probe never reads or rotates Cursor's refresh
 * token and never writes credentials. The `state.vscdb` connection is opened
 * read-only. An expired access token from both sources means ok=false.
 */

import { execFile as execFileCb } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CursorCredentialsReader');

const KEYCHAIN_SERVICE = 'cursor-access-token';
const KEYCHAIN_ACCOUNT = 'cursor-user';
const VSCDB_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CursorSessionCredential {
  token: string;
  subject: string;
  /** Epoch ms when the session token expires. 0 when the JWT has no exp. */
  expiresAt: number;
}

export type CursorCredentialFailureReason =
  | 'not-found'
  | 'denied'
  | 'expired'
  | 'malformed'
  | 'unsupported';

export interface CursorCredentialResult {
  credential: CursorSessionCredential | null;
  reason?: CursorCredentialFailureReason;
}

export type CursorSecurityExec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface CursorCredentialsReaderOptions {
  platform?: NodeJS.Platform;
  securityExec?: CursorSecurityExec;
  now?: () => number;
  /** Process env (used to resolve the Cursor app data dir). */
  env?: NodeJS.ProcessEnv;
  /** Override the resolved `state.vscdb` path (tests). */
  vscdbPath?: string;
  /** SQLite driver factory — defaults to the real better-sqlite3 driver. */
  driverFactory?: SqliteDriverFactory;
  /** File-existence check (tests). */
  fileExists?: (filePath: string) => boolean;
}

interface CursorJwtPayload {
  sub?: unknown;
  exp?: unknown;
}

/**
 * Lower number = more actionable, so it wins when multiple sources fail. An
 * expired token is the most useful signal (it drives the reauth prompt), while
 * "not-found" is the least specific.
 */
const REASON_PRECEDENCE: Record<CursorCredentialFailureReason, number> = {
  expired: 0,
  malformed: 1,
  denied: 2,
  unsupported: 3,
  'not-found': 4,
};

export class CursorCredentialsReader {
  private readonly platform: NodeJS.Platform;
  private readonly securityExec: CursorSecurityExec;
  private readonly now: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly vscdbPath: string;
  private readonly driverFactory: SqliteDriverFactory;
  private readonly fileExists: (filePath: string) => boolean;

  constructor(opts: CursorCredentialsReaderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.now = opts.now ?? Date.now;
    this.env = opts.env ?? process.env;
    this.vscdbPath = opts.vscdbPath ?? defaultCursorVscdbPath(this.platform, this.env);
    this.driverFactory = opts.driverFactory ?? defaultDriverFactory;
    this.fileExists = opts.fileExists ?? existsSync;
  }

  async read(): Promise<CursorCredentialResult> {
    // 1. Live desktop-app session token — tracks the signed-in GUI exactly.
    const fromVscdb = this.readFromVscdb();
    if (fromVscdb.credential) return fromVscdb;

    // 2. Fall back to the cursor-agent CLI's keychain token (often stale).
    const fromKeychain = await this.readFromKeychain();
    if (fromKeychain.credential) return fromKeychain;

    // Neither source yielded a usable credential — surface the most actionable
    // failure reason so the UI can prompt the right next step.
    return { credential: null, reason: mostActionable(fromVscdb.reason, fromKeychain.reason) };
  }

  /** Read the live access token from Cursor's `state.vscdb` (read-only). */
  private readFromVscdb(): CursorCredentialResult {
    if (!this.vscdbPath || !this.fileExists(this.vscdbPath)) {
      return { credential: null, reason: 'not-found' };
    }

    let driver: SqliteDriver | null = null;
    try {
      driver = this.driverFactory(this.vscdbPath, { readonly: true });
      const row = driver
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get<{ value?: unknown }>(VSCDB_ACCESS_TOKEN_KEY);
      const raw = normaliseVscdbValue(row?.value);
      if (!raw) return { credential: null, reason: 'not-found' };
      return this.parseJwt(raw);
    } catch (err) {
      logger.debug(`Cursor state.vscdb read failed: ${(err as Error).message}`);
      return { credential: null, reason: 'not-found' };
    } finally {
      try {
        driver?.close();
      } catch {
        /* best-effort close */
      }
    }
  }

  /** Read the cursor-agent CLI access token from the macOS Keychain. */
  private async readFromKeychain(): Promise<CursorCredentialResult> {
    if (this.platform !== 'darwin') {
      return { credential: null, reason: 'unsupported' };
    }

    let raw: string | null = null;
    try {
      const { stdout, exitCode } = await this.securityExec(
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      if (exitCode !== 0) return { credential: null, reason: 'not-found' };
      const trimmed = stdout.trim();
      raw = trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      logger.debug(`Cursor keychain read failed: ${(err as Error).message}`);
      return { credential: null, reason: 'not-found' };
    }

    if (!raw) {
      return { credential: null, reason: 'not-found' };
    }

    return this.parseJwt(raw);
  }

  private parseJwt(token: string): CursorCredentialResult {
    const parts = token.split('.');
    if (parts.length < 2) {
      return { credential: null, reason: 'malformed' };
    }

    let payload: CursorJwtPayload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as CursorJwtPayload;
    } catch {
      return { credential: null, reason: 'malformed' };
    }

    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) {
      return { credential: null, reason: 'malformed' };
    }

    const expSeconds = typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : 0;
    const expiresAt = expSeconds > 0 ? Math.round(expSeconds * 1000) : 0;
    if (expiresAt > 0 && expiresAt <= this.now()) {
      return { credential: null, reason: 'expired' };
    }

    return {
      credential: {
        token,
        subject,
        expiresAt,
      },
    };
  }
}

/**
 * Resolve the platform-specific path to Cursor's `state.vscdb`. Cursor is a
 * VS Code fork, so it follows the standard Electron `userData` layout.
 */
export function defaultCursorVscdbPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  const home = env['HOME'] || os.homedir();
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'] || path.win32.join(home, 'AppData', 'Roaming');
    return path.win32.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.posix.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** Coerce a state.vscdb `ItemTable.value` (TEXT or BLOB) to a trimmed string. */
function normaliseVscdbValue(value: unknown): string | null {
  if (value == null) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Pick the most actionable failure reason among the attempted sources. */
function mostActionable(
  ...reasons: (CursorCredentialFailureReason | undefined)[]
): CursorCredentialFailureReason {
  const defined = reasons.filter((r): r is CursorCredentialFailureReason => r !== undefined);
  if (defined.length === 0) return 'not-found';
  return defined.reduce((best, r) =>
    REASON_PRECEDENCE[r] < REASON_PRECEDENCE[best] ? r : best,
  );
}

const defaultSecurityExec: CursorSecurityExec = (args, { timeoutMs }) => {
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
