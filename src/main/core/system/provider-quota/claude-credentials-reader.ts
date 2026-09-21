/**
 * ClaudeCredentialsReader
 *
 * Reads the Claude Code OAuth access token that already lives on the machine
 * so the quota poller can call the undocumented `GET /api/oauth/usage`
 * endpoint with `Authorization: Bearer …`.
 *
 * CRITICAL — Claude Code owns the refresh
 * ───────────────────────────────────────
 * This module NEVER writes, refreshes, or rotates the token itself. The stored
 * `refresh_token` is single-use: posting it from Harness would invalidate the
 * copy Claude Code holds and break the user's login. We only ever READ the
 * credential. When the access token is expired (or inside the expiry-skew
 * window), we run the non-inference `claude doctor` command so Claude Code can
 * refresh its own Keychain item, then reread it. `claude auth status` and
 * `claude auth login` do not do this: status is local, and login no-ops when
 * Claude already considers the profile signed in.
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

import { execFile as execFileCb, spawn as spawnChild } from 'child_process';
import { existsSync } from 'fs';
import { readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { CLAUDE_STRIPPED_AUTH_ENV_VARS } from '../../../cli/adapters/adapter-spawn-helpers';
import { claudeKeychainServiceName } from '../../../cli/adapters/account-pool/provider-account-home-resolver';
import { buildCliEnv } from '../../../cli/cli-environment';
import { CLI_REGISTRY, getCliCandidatePaths } from '../../../cli/cli-registry';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('ClaudeCredentialsReader');

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
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
  | 'not-found'      // no keychain entry / no credentials file
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
   * file is `<configDir>/.credentials.json` (decision D6). The same string is
   * exported when asking Claude Code to refresh its own credential.
   */
  configDir?: string;
  /** Delegates an expired-token refresh to Claude Code itself (`claude doctor`). */
  refreshCliAuth?: () => Promise<boolean>;
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
  private readonly refreshCliAuth: () => Promise<boolean>;

  constructor(opts: ClaudeCredentialsReaderOptions = {}) {
    this.configDir = opts.configDir;
    this.platform = opts.platform ?? process.platform;
    this.homeDir = opts.homeDir ?? os.homedir();
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.now = opts.now ?? Date.now;
    this.refreshCliAuth = opts.refreshCliAuth ?? createClaudeCliAuthRefresh(opts.configDir);
  }

  /**
   * Read the stored credential. Never throws — failures map to a
   * {@link CredentialResult} with a `reason` so the caller can degrade.
   */
  async read(): Promise<CredentialResult> {
    const first = await this.readOnce();
    if (first.reason !== 'expired') return first;

    try {
      if (await this.refreshCliAuth()) {
        return await this.readOnce();
      }
    } catch (err) {
      logger.debug(`Claude Code credential refresh failed: ${(err as Error).message}`);
    }
    return first;
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
    if (!oauth || typeof accessToken !== 'string' || accessToken.length === 0) {
      return { credential: null, reason: 'malformed' };
    }

    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : 0;
    // Near-expiry is treated as expired so Claude Code refreshes before the
    // usage probe spends a cycle on a token that is about to 401.
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

/**
 * Ask Claude Code to refresh its own Keychain / credentials-file item.
 *
 * `claude doctor` is a non-inference health check that still loads OAuth and
 * runs `checkAndRefreshOAuthTokenIfNeeded`. `claude auth status` does not
 * touch the network; `claude auth login` no-ops when the profile is already
 * marked signed in. Ambient API-key / OAuth env vars are stripped so a
 * profile-routed spawn cannot silently become a different account.
 */
export function createClaudeCliAuthRefresh(
  configDir?: string,
  timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
): () => Promise<boolean> {
  return async () => {
    return new Promise<boolean>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...buildCliEnv() };
      for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS) {
        delete env[key];
      }
      if (configDir !== undefined) {
        env['CLAUDE_CONFIG_DIR'] = configDir;
      }

      const proc = spawnChild(resolveClaudeCliCommand(), ['doctor'], {
        env,
        cwd: os.tmpdir(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };

      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // Process may already be closed.
        }
        finish(false);
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      proc.on('error', () => finish(false));
      proc.on('close', (code) => finish(code === 0));
    });
  };
}

function resolveClaudeCliCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const config = CLI_REGISTRY.claude;
  const candidate = getCliCandidatePaths(config, env, platform).find((p) => existsSync(p));
  return candidate ?? config.command;
}
