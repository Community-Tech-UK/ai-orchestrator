/**
 * CursorCredentialsReader
 *
 * Reads Cursor's dashboard session JWT from the macOS Keychain so AIO can call
 * Cursor's read-only usage-summary endpoint without depending on the external
 * token-usage-monitor. This is deliberately read-only: we never read or rotate
 * Cursor's refresh-token item, and an expired access token simply skips the
 * quota probe until Cursor refreshes its own login.
 */

import { execFile as execFileCb } from 'child_process';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CursorCredentialsReader');

const KEYCHAIN_SERVICE = 'cursor-access-token';
const KEYCHAIN_ACCOUNT = 'cursor-user';
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
}

interface CursorJwtPayload {
  sub?: unknown;
  exp?: unknown;
}

export class CursorCredentialsReader {
  private readonly platform: NodeJS.Platform;
  private readonly securityExec: CursorSecurityExec;
  private readonly now: () => number;

  constructor(opts: CursorCredentialsReaderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.now = opts.now ?? Date.now;
  }

  async read(): Promise<CursorCredentialResult> {
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
