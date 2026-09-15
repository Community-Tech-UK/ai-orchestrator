import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));

import { ProviderAccountBindingService, type ClaudeAuthStatusResult } from './provider-account-binding-service';

const HOME = '/state/claude-cli-profiles/max-b';

function profile(provider: 'claude' | 'codex', id: string, expectedIdentity: string | null = null): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity, expectedAccountKey: null, planLabel: null, priority: 1,
    enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

let now = 1000;
let claudeResult: ClaudeAuthStatusResult;
let codexAuth: string | null;
const seenEnv: NodeJS.ProcessEnv[] = [];

function service(): ProviderAccountBindingService {
  return new ProviderAccountBindingService({
    resolveHome: ({ profileId }) => (profileId === 'legacy' ? { kind: 'legacy' } : { kind: 'derived', home: HOME }),
    runClaudeAuthStatus: async (env) => {
      seenEnv.push(env);
      return claudeResult;
    },
    readCodexAuthHead: async () => codexAuth,
    legacyCodexHome: () => '/home/.codex',
    now: () => now,
  });
}

function claudeJson(fields: Record<string, unknown>, exitCode = 0): ClaudeAuthStatusResult {
  return { exitCode, stdout: JSON.stringify(fields), timedOut: false };
}

beforeEach(() => {
  now = 1000;
  seenEnv.length = 0;
  process.env['ANTHROPIC_API_KEY'] = 'ambient-placeholder';
});

describe('Claude binding', () => {
  it('authenticates a derived profile whose config dir matches, with the profile env only', async () => {
    claudeResult = claudeJson({ loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', subscriptionType: 'max', configDirectory: HOME });
    const status = await service().checkBinding(profile('claude', 'max-b'));
    expect(status).toMatchObject({ state: 'authenticated', observedIdentity: 'a@example.com', observedPlan: 'max' });
    expect(seenEnv[0]?.['CLAUDE_CONFIG_DIR']).toBe(HOME);
    expect(seenEnv[0]?.['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('flags byte drift in the config dir as unavailable', async () => {
    claudeResult = claudeJson({ loggedIn: true, authMethod: 'claude.ai', email: 'a@example.com', configDirectory: `${HOME}/` });
    expect(await service().checkBinding(profile('claude', 'max-b'))).toMatchObject({ state: 'unavailable', errorCode: 'config-dir-mismatch' });
  });

  it('reports unauthenticated on exit 1 and mismatch against the expected identity', async () => {
    claudeResult = claudeJson({ loggedIn: false }, 1);
    expect((await service().checkBinding(profile('claude', 'max-b'))).state).toBe('unauthenticated');
    claudeResult = claudeJson({ loggedIn: true, authMethod: 'claude.ai', email: 'B@example.com', configDirectory: HOME });
    expect((await service().checkBinding(profile('claude', 'max-b', 'b@EXAMPLE.com'))).state).toBe('authenticated');
    expect((await service().checkBinding(profile('claude', 'max-b', 'c@example.com'))).state).toBe('identity-mismatch');
  });

  it('treats a timeout as unavailable and sets no config dir for legacy', async () => {
    claudeResult = { exitCode: null, stdout: '', timedOut: true };
    expect(await service().checkBinding(profile('claude', 'legacy'))).toMatchObject({ state: 'unavailable', errorCode: 'timeout' });
    expect(seenEnv[0]?.['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('caches for 30 seconds', async () => {
    claudeResult = claudeJson({ loggedIn: true, authMethod: 'claude.ai', configDirectory: HOME });
    const bindings = service();
    await bindings.checkBinding(profile('claude', 'max-b'));
    await bindings.checkBinding(profile('claude', 'max-b'));
    expect(seenEnv).toHaveLength(1);
    now += 31_000;
    await bindings.checkBinding(profile('claude', 'max-b'));
    expect(seenEnv).toHaveLength(2);
  });
});

describe('Codex binding', () => {
  it('requires a chatgpt sign-in for a derived profile', async () => {
    codexAuth = null;
    expect((await service().checkBinding(profile('codex', 'pro-b'))).state).toBe('unauthenticated');
    codexAuth = '{"auth_mode":"apikey"}';
    expect(await service().checkBinding(profile('codex', 'pro-b'))).toMatchObject({ state: 'unavailable', errorCode: 'not-chatgpt-auth' });
    codexAuth = 'not json';
    expect(await service().checkBinding(profile('codex', 'pro-b'))).toMatchObject({ state: 'unavailable', errorCode: 'auth-unreadable' });
    codexAuth = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"placeholder"}}';
    const status = await service().checkBinding(profile('codex', 'pro-b'));
    expect(status.state).toBe('authenticated');
    expect(JSON.stringify(status)).not.toContain('placeholder');
  });

  it('allows an API-key legacy sign-in and compares a probed identity', async () => {
    codexAuth = '{"auth_mode":"apikey"}';
    expect((await service().checkBinding(profile('codex', 'legacy'))).state).toBe('authenticated');
    codexAuth = '{"auth_mode":"chatgpt"}';
    const bindings = service();
    bindings.rememberObservedIdentity('codex', 'pro-b', { identity: 'x@example.com', accountKey: 'acct-1' });
    expect(await bindings.checkBinding(profile('codex', 'pro-b', 'y@example.com'))).toMatchObject({ state: 'identity-mismatch', observedAccountKey: 'acct-1' });
  });
});
