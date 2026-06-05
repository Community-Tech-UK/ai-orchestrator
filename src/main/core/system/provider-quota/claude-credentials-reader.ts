/**
 * ClaudeCredentialsReader
 *
 * Reads the Claude Code OAuth access token that already lives on the machine
 * so the quota poller can call the undocumented `GET /api/oauth/usage`
 * endpoint with `Authorization: Bearer …`.
 *
 * CRITICAL — read-only token discipline
 * ─────────────────────────────────────
 * This module NEVER writes, refreshes, or rotates the token. The stored
 * `refresh_token` is single-use: rotating it (the normal OAuth refresh flow)
 * would invalidate the copy Claude Code holds and break the user's login. We
 * only ever READ the credential and, if the access token is already expired,
 * we skip the cycle entirely rather than trying to refresh it.
 *
 * Storage locations (platform-dependent):
 *   • macOS  — Keychain generic password, service `Claude Code-credentials`.
 *              Read via `security find-generic-password -s … -w` (no shell).
 *   • Linux  — `~/.claude/.credentials.json` (plaintext file Claude Code writes
 *              when no system keyring is available).
 *   • Windows — `~/.claude/.credentials.json` (same fallback file).
 *
 * The secret payload (either source) is JSON shaped like:
 *   { "claudeAiOauth": { "accessToken", "refreshToken", "expiresAt",
 *                        "scopes", "subscriptionType" } }
 */

import { execFile as execFileCb } from 'child_process';
import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('ClaudeCredentialsReader');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_TIMEOUT_MS = 5_000;

/** A read-only view of the stored Claude OAuth credential. */
export interface ClaudeOAuthCredential {
  accessToken: string;
  /** Epoch ms when the access token expires. 0 when the field is absent. */
  expiresAt: number;
  /** Plan tier reported alongside the token, when present (e.g. 'max'). */
  subscriptionType?: string;
}

/** Why a token could not be produced — surfaced so the probe can explain itself. */
export type CredentialFailureReason =
  | 'not-found'      // no keychain entry / no credentials file
  | 'denied'         // keychain access prompt rejected / permission error
  | 'expired'        // token present but past expiry (we never refresh)
  | 'malformed'      // payload present but not parseable / missing accessToken
  | 'unsupported';   // platform without a known credential location

export interface CredentialResult {
  credential: ClaudeOAuthCredential | null;
  reason?: CredentialFailureReason;
}

/** Pluggable keychain exec — tests inject a fake; production wraps `security`. */
export type SecurityExec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Pluggable file reader — tests inject a fake; production uses fs/promises. */
export type CredentialsFileReader = (filePath: string) => Promise<string>;

export interface ClaudeCredentialsReaderOptions {
  platform?: NodeJS.Platform;
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Keychain exec override (tests). Defaults to a `security` wrapper. */
  securityExec?: SecurityExec;
  /** Credentials-file reader override (tests). Defaults to fs/promises. */
  readFile?: CredentialsFileReader;
  /** Clock override (tests). Defaults to `Date.now`. */
  now?: () => number;
}

interface StoredCredentialsJson {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
  };
}

export class ClaudeCredentialsReader {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly securityExec: SecurityExec;
  private readonly readFile: CredentialsFileReader;
  private readonly now: () => number;

  constructor(opts: ClaudeCredentialsReaderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Read the stored credential. Never throws — failures map to a
   * {@link CredentialResult} with a `reason` so the caller can degrade.
   */
  async read(): Promise<CredentialResult> {
    let raw: string | null = null;
    if (this.platform === 'darwin') {
      raw = await this.readFromKeychain();
      // Fall through to the file on a miss — some setups (e.g. headless) keep
      // the JSON file even on macOS.
      if (raw === null) raw = await this.readFromFileSafe();
    } else {
      raw = await this.readFromFileSafe();
    }

    if (raw === null) {
      return { credential: null, reason: 'not-found' };
    }

    return this.parse(raw);
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private async readFromKeychain(): Promise<string | null> {
    try {
      const { stdout, exitCode } = await this.securityExec(
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      if (exitCode !== 0) return null;
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      logger.debug(`Keychain read failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async readFromFileSafe(): Promise<string | null> {
    try {
      return await this.readFile(this.credentialsFilePath());
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && code !== 'ENOENT') {
        logger.debug(`Credentials file read failed (${code})`);
      }
      return null;
    }
  }

  private credentialsFilePath(): string {
    return path.join(this.homeDir, '.claude', '.credentials.json');
  }

  private parse(raw: string): CredentialResult {
    let parsed: StoredCredentialsJson;
    try {
      parsed = JSON.parse(raw) as StoredCredentialsJson;
    } catch {
      return { credential: null, reason: 'malformed' };
    }

    const oauth = parsed.claudeAiOauth;
    const accessToken = oauth?.accessToken;
    if (!oauth || typeof accessToken !== 'string' || accessToken.length === 0) {
      return { credential: null, reason: 'malformed' };
    }

    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
    // Read-only discipline: never refresh. Expired token → skip this cycle.
    if (expiresAt > 0 && expiresAt <= this.now()) {
      return { credential: null, reason: 'expired' };
    }

    return {
      credential: {
        accessToken,
        expiresAt,
        subscriptionType:
          typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : undefined,
      },
    };
  }
}

/**
 * Production `security` wrapper. Uses `execFile` (no shell) and resolves with
 * stdout/stderr/exitCode rather than throwing on non-zero exit so the reader
 * can treat "no entry" as a clean miss.
 */
const defaultSecurityExec: SecurityExec = (args, { timeoutMs }) => {
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
          // System errors (ENOENT for the binary, timeouts) reject.
          if (typeof code === 'string') return reject(err);
          // Numeric exit (e.g. 44 = item not found) is a clean miss.
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
