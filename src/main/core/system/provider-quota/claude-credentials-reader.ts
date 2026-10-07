/**
 * ClaudeCredentialsReader
 *
 * Reads the Claude Code OAuth access token that already lives on the machine
 * so the quota poller can call the undocumented `GET /api/oauth/usage`
 * endpoint with `Authorization: Bearer …`.
 *
 * CRITICAL — read only
 * ─────────────────────
 * This module NEVER writes, refreshes, or rotates the token. The stored
 * `refresh_token` is single-use. Claude Code deletes the whole Keychain item's
 * token fields when a refresh is rejected (`invalid_grant` writes an empty
 * access token and `expiresAt: 0`), which is a signed-out account, not a
 * transient skip. A background `claude doctor` is enough to cause that, so
 * the quota reader does not launch one. A real Claude Code session refreshes
 * its own credential; until then an expired access token is reported as
 * expired and left untouched.
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
import { claudeKeychainServiceName } from '../../../cli/adapters/account-pool/provider-account-home-resolver';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('ClaudeCredentialsReader');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 90_000;

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
  | 'not-found'      // no keychain entry / no credentials file / blanked by a rejected refresh
  | 'denied'         // keychain access prompt rejected / permission error
  | 'expired'        // token present but past expiry after Claude Code refresh
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
  /**
   * Account-pool profile config dir (`CLAUDE_CONFIG_DIR`). When set, the
   * Keychain item is the one Claude Code keys on this exact string and the
   * file is `<configDir>/.credentials.json` (decision D6).
   */
  configDir?: string;
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
  private readonly configDir: string | undefined;

  constructor(opts: ClaudeCredentialsReaderOptions = {}) {
    this.configDir = opts.configDir;
    this.platform = opts.platform ?? process.platform;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Read the stored credential. Never throws — failures map to a
   * {@link CredentialResult} with a `reason` so the caller can degrade.
   * Expired tokens are returned as `expired` and are not sent through
   * `claude doctor`.
   */
  async read(): Promise<CredentialResult> {
    return this.readOnce();
  }

  private async readOnce(): Promise<CredentialResult> {
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
        ['find-generic-password', '-s', this.configDir === undefined ? KEYCHAIN_SERVICE : claudeKeychainServiceName(this.configDir), '-w'],
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
    const pathApi = this.platform === 'win32' ? path.win32 : path.posix;
    if (this.configDir !== undefined) return pathApi.join(this.configDir, '.credentials.json');
    return pathApi.join(this.homeDir, '.claude', '.credentials.json');
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
    // When the server rejects a refresh, Claude Code keeps the item but blanks
    // its token fields. That is a signed-out profile, not a corrupt credential.
    if (accessToken === '') {
      return { credential: null, reason: 'not-found' };
    }
    if (!oauth || typeof accessToken !== 'string') {
      return { credential: null, reason: 'malformed' };
    }

    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
    // Near-expiry is treated as expired so the usage probe does not spend a
    // cycle on a token that is about to be rejected. The stored credential
    // is left as Claude Code wrote it.
    if (expiresAt > 0 && expiresAt <= this.now() + EXPIRY_SKEW_MS) {
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
