/**
 * Hardened (Seatbelt) Claude sessions must never refresh the shared login.
 *
 * Claude Code refresh tokens are single-use. A jailed CLI can read its
 * Keychain item but cannot write it (LT-029: Keychain mutation is a file
 * write outside the jail's roots). When it refreshes, Claude Code stores the
 * new tokens in the plain-text fallback file instead and the Keychain keeps
 * the spent refresh token. The next process that refreshes from the Keychain
 * re-uses that token, and the server revokes the whole login: every session
 * on that account fails with "OAuth token revoked" and needs a fresh sign-in
 * (observed on both pooled Claude accounts, 2026-10-17).
 *
 * So a hardened spawn is handed the current access token through Claude
 * Code's own environment variables. With no refresh token in hand the jailed
 * CLI cannot refresh. Claude Code scrubs these variables from the tools it
 * runs. When the stored token is already inside Claude Code's refresh window,
 * one small non-jailed request for that account refreshes it first, through
 * Claude Code's normal Keychain-writing path.
 */

import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { ClaudeCredentialsReader, type StoredClaudeLogin } from '../../core/system/provider-quota/claude-credentials-reader';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { buildCliSpawnOptions } from '../cli-environment';
import { CLAUDE_STRIPPED_AUTH_ENV_VARS } from './adapter-spawn-helpers';

const logger = getLogger('ClaudeHardenedLogin');

/** Claude Code refreshes a token this close to expiry (`isOAuthTokenExpired`, 2.1.302). */
export const CLAUDE_REFRESH_WINDOW_MS = 5 * 60_000;
/** Generous: killing the refresh request mid-flight would itself lose the new token. */
const REFRESH_TIMEOUT_MS = 120_000;
const REFRESH_PROMPT = 'Reply with the single word OK.';

export interface HardenedLoginDeps {
  readStoredLogin: (configDir: string | undefined) => Promise<StoredClaudeLogin | null>;
  /** Run a normal (non-jailed) Claude request for this account so Claude Code refreshes its login. */
  refreshOutsideJail: (configDir: string | undefined) => Promise<void>;
  now: () => number;
}

const defaultDeps: HardenedLoginDeps = {
  readStoredLogin: (configDir) => new ClaudeCredentialsReader(configDir === undefined ? {} : { configDir }).readStoredLogin(),
  refreshOutsideJail: runRefreshRequest,
  now: Date.now,
};

const refreshesInFlight = new Map<string, Promise<void>>();

/** Claude Code's variables for a login supplied by the host instead of its own store. */
export function buildHandedInLoginEnv(login: StoredClaudeLogin): Record<string, string> {
  return {
    CLAUDE_CODE_OAUTH_TOKEN: login.accessToken,
    ...(login.scopes.length > 0 ? { CLAUDE_CODE_OAUTH_SCOPES: login.scopes.join(' ') } : {}),
    ...(login.subscriptionType ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: login.subscriptionType } : {}),
    ...(login.rateLimitTier ? { CLAUDE_CODE_RATE_LIMIT_TIER: login.rateLimitTier } : {}),
  };
}

/**
 * Environment that hands a hardened spawn the account's current login, or
 * null when nothing is stored (the jailed CLI then reports "not logged in",
 * which the auth-repair flow handles). Never throws.
 */
export async function prepareHardenedClaudeLoginEnv(
  configDir: string | undefined,
  deps: HardenedLoginDeps = defaultDeps,
): Promise<Record<string, string> | null> {
  try {
    let login = await deps.readStoredLogin(configDir);
    if (login === null) {
      logger.info('No stored Claude login to hand to a hardened session', { account: accountLabel(configDir) });
      return null;
    }
    if (login.hasRefreshToken && login.expiresAt > 0 && login.expiresAt - deps.now() < CLAUDE_REFRESH_WINDOW_MS) {
      await refreshOnce(configDir, deps);
      login = (await deps.readStoredLogin(configDir)) ?? login;
    }
    const expiresInMinutes = login.expiresAt > 0 ? Math.round((login.expiresAt - deps.now()) / 60_000) : null;
    logger.info('Handing the stored Claude login to a hardened session', {
      account: accountLabel(configDir),
      expiresInMinutes,
    });
    return buildHandedInLoginEnv(login);
  } catch (error) {
    logger.warn('Could not prepare the Claude login for a hardened session', {
      account: accountLabel(configDir),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** One refresh per account at a time; concurrent hardened spawns share it. */
async function refreshOnce(configDir: string | undefined, deps: HardenedLoginDeps): Promise<void> {
  const key = accountLabel(configDir);
  let pending = refreshesInFlight.get(key);
  if (!pending) {
    pending = deps.refreshOutsideJail(configDir)
      .catch((error: unknown) => {
        logger.warn('Refreshing the Claude login outside the jail failed', {
          account: key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => refreshesInFlight.delete(key));
    refreshesInFlight.set(key, pending);
  }
  await pending;
}

function accountLabel(configDir: string | undefined): string {
  return configDir ?? 'default';
}

/**
 * A minimal headless request outside the jail. Claude Code refreshes an
 * expiring token before it sends the request and stores the result in the
 * Keychain, coordinating with other Claude processes through its own lock.
 */
function runRefreshRequest(configDir: string | undefined): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...getSafeEnvForTrustedProcess() };
  delete env['CLAUDECODE'];
  for (const key of CLAUDE_STRIPPED_AUTH_ENV_VARS) delete env[key];
  if (configDir !== undefined) env['CLAUDE_CONFIG_DIR'] = configDir;
  const args = [
    '-p',
    '--model', 'haiku',
    '--strict-mcp-config',
    '--tools', '',
    '--no-session-persistence',
    '--max-turns', '1',
    '--output-format', 'json',
    REFRESH_PROMPT,
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'claude',
      args,
      { cwd: tmpdir(), timeout: REFRESH_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...buildCliSpawnOptions(env) },
      (error) => {
        if (error) {
          // The message can include argv, never the environment.
          reject(new Error(`claude refresh request failed: ${error.message.slice(0, 200)}`));
          return;
        }
        resolve();
      },
    );
  });
}

export function _resetClaudeHardenedLoginForTesting(): void {
  refreshesInFlight.clear();
}
