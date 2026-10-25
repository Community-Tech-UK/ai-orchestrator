import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const logCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: (...args: unknown[]) => logCalls.push(args),
    warn: (...args: unknown[]) => logCalls.push(args),
    debug: (...args: unknown[]) => logCalls.push(args),
    error: (...args: unknown[]) => logCalls.push(args),
  }),
}));

import {
  CLAUDE_REFRESH_WINDOW_MS,
  _resetClaudeHardenedLoginForTesting,
  buildHandedInLoginEnv,
  prepareHardenedClaudeLoginEnv,
  type HardenedLoginDeps,
} from './claude-hardened-login';
import type { StoredClaudeLogin } from '../../core/system/provider-quota/claude-credentials-reader';

const NOW = 1_800_000_000_000;
const TOKEN = 'test-access-token-placeholder';

function login(overrides: Partial<StoredClaudeLogin> = {}): StoredClaudeLogin {
  return {
    accessToken: TOKEN,
    expiresAt: NOW + 4 * 60 * 60_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    hasRefreshToken: true,
    ...overrides,
  };
}

function deps(stored: (StoredClaudeLogin | null)[], refresh: Mock<HardenedLoginDeps['refreshOutsideJail']> = vi.fn(async () => undefined)): HardenedLoginDeps & {
  readStoredLogin: Mock<HardenedLoginDeps['readStoredLogin']>;
  refreshOutsideJail: typeof refresh;
} {
  const queue = [...stored];
  return {
    readStoredLogin: vi.fn(async () => (queue.length > 1 ? queue.shift() : queue[0]) ?? null),
    refreshOutsideJail: refresh,
    now: () => NOW,
  };
}

describe('claude hardened login hand-in', () => {
  beforeEach(() => {
    logCalls.length = 0;
    _resetClaudeHardenedLoginForTesting();
  });

  it('builds Claude Code\'s host-supplied login variables, without a refresh token', () => {
    expect(buildHandedInLoginEnv(login())).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
      CLAUDE_CODE_OAUTH_SCOPES: 'user:inference user:profile',
      CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max',
      CLAUDE_CODE_RATE_LIMIT_TIER: 'default_claude_max_20x',
    });
    expect(buildHandedInLoginEnv(login({ scopes: [], subscriptionType: undefined, rateLimitTier: undefined })))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it('hands in a token with time left without refreshing it', async () => {
    const d = deps([login()]);

    await expect(prepareHardenedClaudeLoginEnv('/profiles/comtech', d)).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });

    expect(d.readStoredLogin).toHaveBeenCalledWith('/profiles/comtech');
    expect(d.refreshOutsideJail).not.toHaveBeenCalled();
  });

  it('refreshes outside the jail first when the token is inside Claude Code\'s refresh window', async () => {
    const fresh = login({ accessToken: 'fresh-token-placeholder', expiresAt: NOW + 8 * 60 * 60_000 });
    const d = deps([login({ expiresAt: NOW + CLAUDE_REFRESH_WINDOW_MS - 1 }), fresh]);

    const env = await prepareHardenedClaudeLoginEnv(undefined, d);

    expect(d.refreshOutsideJail).toHaveBeenCalledTimes(1);
    expect(d.refreshOutsideJail).toHaveBeenCalledWith(undefined);
    expect(env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token-placeholder');
  });

  it('refreshes an already expired token too', async () => {
    const d = deps([login({ expiresAt: NOW - 60_000 }), login({ accessToken: 'fresh-token-placeholder' })]);

    const env = await prepareHardenedClaudeLoginEnv(undefined, d);

    expect(d.refreshOutsideJail).toHaveBeenCalledTimes(1);
    expect(env?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fresh-token-placeholder');
  });

  it('shares one refresh between hardened sessions starting at once on the same account', async () => {
    let release!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const d = deps([login({ expiresAt: NOW + 1_000 })], refresh);

    const first = prepareHardenedClaudeLoginEnv('/profiles/comtech', d);
    const second = prepareHardenedClaudeLoginEnv('/profiles/comtech', d);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('still hands in the stored token when the refresh fails, so the jail never refreshes itself', async () => {
    const refresh = vi.fn(async () => { throw new Error('network down'); });
    const d = deps([login({ expiresAt: NOW + 1_000 })], refresh);

    await expect(prepareHardenedClaudeLoginEnv(undefined, d)).resolves.toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
  });

  it('does not try to refresh a login that has no refresh token', async () => {
    const d = deps([login({ expiresAt: NOW - 1, hasRefreshToken: false })]);

    await prepareHardenedClaudeLoginEnv(undefined, d);

    expect(d.refreshOutsideJail).not.toHaveBeenCalled();
  });

  it('hands in nothing when no login is stored', async () => {
    await expect(prepareHardenedClaudeLoginEnv(undefined, deps([null]))).resolves.toBeNull();
  });

  it('returns null rather than throwing when the store cannot be read', async () => {
    const d = deps([login()]);
    d.readStoredLogin.mockRejectedValueOnce(new Error('security exited 51'));

    await expect(prepareHardenedClaudeLoginEnv(undefined, d)).resolves.toBeNull();
  });

  it('never writes the token to the log', async () => {
    await prepareHardenedClaudeLoginEnv(undefined, deps([login({ expiresAt: NOW + 1_000 }), login()]));

    expect(logCalls.length).toBeGreaterThan(0);
    expect(JSON.stringify(logCalls)).not.toContain(TOKEN);
  });
});
