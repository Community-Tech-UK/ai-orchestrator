/**
 * The environment a recall-check child CLI runs with.
 *
 * Claude Code refresh tokens are single use, and a CLI that cannot store a refreshed
 * login in the Keychain leaves the old token behind, which later revokes the whole
 * account (see claude-hardened-login.ts). So the child is handed the current access
 * token only, under Claude Code's own variables, and has no refresh token to spend.
 * Nothing else from the parent environment is passed on: session variables,
 * messaging tokens, other API keys and a different config directory stay behind.
 *
 * Nothing in this file prints or returns the stored refresh token.
 */

/** A recall run takes well under an hour; refuse to start with less login left than this. */
export const MIN_LOGIN_MINUTES = 90;

export interface HandedInLogin {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** Reads the Keychain item's JSON and keeps the access side only. Returns null if unusable. */
export function parseStoredLogin(raw: string): HandedInLogin | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
    if (!oauth || typeof oauth['accessToken'] !== 'string' || oauth['accessToken'].length === 0) return null;
    if (typeof oauth['expiresAt'] !== 'number' || !Number.isFinite(oauth['expiresAt'])) return null;
    return {
      accessToken: oauth['accessToken'],
      expiresAt: oauth['expiresAt'],
      scopes: Array.isArray(oauth['scopes']) ? oauth['scopes'].filter((scope): scope is string => typeof scope === 'string') : [],
      ...(typeof oauth['subscriptionType'] === 'string' ? { subscriptionType: oauth['subscriptionType'] } : {}),
      ...(typeof oauth['rateLimitTier'] === 'string' ? { rateLimitTier: oauth['rateLimitTier'] } : {}),
    };
  } catch {
    return null;
  }
}

const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

export function buildChildEnv(parent: NodeJS.ProcessEnv, login: HandedInLogin): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH) {
    const value = parent[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  env['CLAUDE_CODE_OAUTH_TOKEN'] = login.accessToken;
  if (login.scopes.length > 0) env['CLAUDE_CODE_OAUTH_SCOPES'] = login.scopes.join(' ');
  if (login.subscriptionType) env['CLAUDE_CODE_SUBSCRIPTION_TYPE'] = login.subscriptionType;
  if (login.rateLimitTier) env['CLAUDE_CODE_RATE_LIMIT_TIER'] = login.rateLimitTier;
  return env;
}

export function loginMinutesLeft(login: HandedInLogin, now: number): number {
  return Math.floor((login.expiresAt - now) / 60_000);
}
