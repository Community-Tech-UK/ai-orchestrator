import { describe, expect, it } from 'vitest';
import { MIN_LOGIN_MINUTES, buildChildEnv, loginMinutesLeft, parseStoredLogin } from './recall-cli-env';

// Placeholders only: no real credential is used anywhere in this file.
const PLACEHOLDER_ACCESS = 'placeholder-access-value';
const PLACEHOLDER_REFRESH = 'placeholder-refresh-value';
const stored = (over: Record<string, unknown> = {}): string => JSON.stringify({
  mcpOAuth: { server: { token: 'placeholder-mcp' } },
  claudeAiOauth: {
    accessToken: PLACEHOLDER_ACCESS, refreshToken: PLACEHOLDER_REFRESH, expiresAt: 5_000_000, scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max', rateLimitTier: 'tier-x', ...over,
  },
});

describe('parseStoredLogin', () => {
  it('keeps only what a child needs and drops the refresh token and everything else', () => {
    const login = parseStoredLogin(stored());
    expect(login).toEqual({ accessToken: PLACEHOLDER_ACCESS, expiresAt: 5_000_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', rateLimitTier: 'tier-x' });
    expect(JSON.stringify(login)).not.toContain(PLACEHOLDER_REFRESH);
    expect(JSON.stringify(login)).not.toContain('placeholder-mcp');
  });

  it('returns null for anything unusable', () => {
    for (const raw of ['', 'not json', '{}', JSON.stringify({ claudeAiOauth: {} }), stored({ accessToken: '' }), stored({ accessToken: 7 }), stored({ expiresAt: 'soon' })]) {
      expect(parseStoredLogin(raw), raw.slice(0, 30)).toBeNull();
    }
  });

  it('tolerates missing optional fields', () => {
    expect(parseStoredLogin(stored({ scopes: undefined, subscriptionType: undefined, rateLimitTier: undefined }))).toEqual({ accessToken: PLACEHOLDER_ACCESS, expiresAt: 5_000_000, scopes: [] });
  });
});

describe('buildChildEnv', () => {
  const login = parseStoredLogin(stored())!;
  const parent = {
    PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LANG: 'en_GB.UTF-8', TMPDIR: '/tmp/x',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 'placeholder-messaging', AIO_MCP: 'socket',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: PLACEHOLDER_REFRESH, ANTHROPIC_API_KEY: 'placeholder-key', CLAUDE_CONFIG_DIR: '/other', SECRET_THING: 'x',
  };

  it('hands over the access token only and strips session, messaging and other credentials', () => {
    const env = buildChildEnv(parent, login);
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/home/u', USER: 'u', LANG: 'en_GB.UTF-8', TMPDIR: '/tmp/x',
      CLAUDE_CODE_OAUTH_TOKEN: PLACEHOLDER_ACCESS, CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile',
      CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max', CLAUDE_CODE_RATE_LIMIT_TIER: 'tier-x',
    });
    expect(JSON.stringify(env)).not.toContain(PLACEHOLDER_REFRESH);
  });
});

describe('loginMinutesLeft', () => {
  it('counts whole minutes and goes negative once expired', () => {
    const login = parseStoredLogin(stored({ expiresAt: 10 * 60_000 }))!;
    expect(loginMinutesLeft(login, 4 * 60_000)).toBe(6);
    expect(loginMinutesLeft(login, 12 * 60_000)).toBe(-2);
    expect(MIN_LOGIN_MINUTES).toBeGreaterThanOrEqual(60);
  });
});
