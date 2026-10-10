import { execFile, type ChildProcess, type ExecFileException } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));

import { ProviderAccountBindingService, type ClaudeAuthStatusResult } from './provider-account-binding-service';
import { emitProviderAccountEvent } from './provider-account-events';
import { materializeWorkerAccountRoute } from '../../../worker-agent/worker-account-route';

const mockExecFile = vi.mocked(execFile);

function authListReply(error: ExecFileException | null, stdout: string): void {
  mockExecFile.mockImplementation((file, args, options, callback) => {
    expect(file).toBe('opencode');
    expect(args).toEqual(['auth', 'list']);
    expect(options).toMatchObject({ timeout: 8_000, maxBuffer: 256 * 1024 });
    if (!callback) throw new Error('Missing auth-list callback');
    queueMicrotask(() => callback(error, stdout, 'stderr-placeholder'));
    return {} as ChildProcess;
  });
}

const HOME = '/state/claude-cli-profiles/max-b';

function profile(
  provider: 'claude' | 'codex' | 'opencode',
  id: string,
  expectedIdentity: string | null = null,
): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity, expectedAccountKey: null, planLabel: null, priority: 1,
    enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}),
  };
}

let now = 1000;
let claudeResult: ClaudeAuthStatusResult;
let codexAuth: string | null;
let openCodeAuthList: string | null;
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
    readOpenCodeAuthList: async () => openCodeAuthList,
    now: () => now,
  });
}

function claudeJson(fields: Record<string, unknown>, exitCode = 0): ClaudeAuthStatusResult {
  return { exitCode, stdout: JSON.stringify(fields), timedOut: false };
}

beforeEach(() => {
  mockExecFile.mockReset();
  vi.mocked(emitProviderAccountEvent).mockClear();
  now = 1000;
  seenEnv.length = 0;
  openCodeAuthList = null;
  process.env['ANTHROPIC_API_KEY'] = 'ambient-placeholder';
});

/** `opencode auth list` fixture (probe P3 shape); placeholder names only. */
const AUTH_LIST_TWO = [
  '┌  Credentials ~/.local/share/opencode/auth.json',
  '│',
  '●  Xiaomi Token Plan (Europe) api',
  '│',
  '●  aio-mimo-max-b-1a2b api',
  '│',
  '└  2 credentials',
].join('\n');

describe('OpenCode/MiMo default subprocess binding and worker admission', () => {
  it.each([
    ['nonzero exit', { code: 7 }],
    ['timeout', { killed: true, signal: 'SIGTERM' }],
    ['signal termination', { signal: 'SIGKILL' }],
    ['buffer overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
    ['spawn failure', { code: 'ENOENT' }],
  ] as const)('refuses %s even with valid-looking credential names', async (_name, properties) => {
    authListReply(Object.assign(new Error('error-placeholder'), properties), AUTH_LIST_TWO);
    const status = await new ProviderAccountBindingService().checkBinding(profile('opencode', 'max-b-1a2b'));
    expect(status).toMatchObject({ state: 'unavailable', errorCode: 'auth-list-unreadable' });
    await expect(materializeWorkerAccountRoute('opencode', {
      provider: 'opencode', profileId: 'max-b-1a2b', region: 'ams',
    })).rejects.toThrow(/sign-in could not be read on this node \(auth-list-unreadable\)/);
    expect(vi.mocked(emitProviderAccountEvent).mock.calls.map(([event]) => event.state))
      .toEqual(['unavailable', 'unavailable']);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenCalledWith('opencode', ['auth', 'list'],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
    expect(JSON.stringify(status)).not.toMatch(/error-placeholder|stderr-placeholder|Credentials/);
  });

  it('refuses a synchronously failed process start', async () => {
    mockExecFile.mockImplementation(() => { throw Object.assign(new Error('error-placeholder'), { code: 'ENOENT' }); });
    expect(await new ProviderAccountBindingService().checkBinding(profile('opencode', 'max-b-1a2b')))
      .toMatchObject({ state: 'unavailable', errorCode: 'check-failed' });
    await expect(materializeWorkerAccountRoute('opencode', {
      provider: 'opencode', profileId: 'max-b-1a2b', region: 'ams',
    })).rejects.toThrow(/sign-in could not be read on this node \(check-failed\)/);
  });

  it.each([
    { name: 'custom credential', output: AUTH_LIST_TWO, id: 'max-b-1a2b', state: 'authenticated' },
    { name: 'legacy display label', output: AUTH_LIST_TWO, id: 'legacy', state: 'authenticated' },
    { name: 'legacy provider ID', output: AUTH_LIST_TWO.replace('Xiaomi Token Plan (Europe)', 'xiaomi-token-plan-ams'), id: 'legacy', state: 'authenticated' },
    { name: 'absent credential', output: AUTH_LIST_TWO, id: 'max-c-2b3c', state: 'unauthenticated' },
    { name: 'zero credentials', output: '┌  Credentials\n└  0 credentials\n', id: 'max-b-1a2b', state: 'unauthenticated' },
    { name: 'empty output', output: '', id: 'max-b-1a2b', state: 'unavailable' },
    { name: 'malformed output', output: 'unexpected output', id: 'max-b-1a2b', state: 'unavailable' },
  ])('retains successful-command semantics for $name', async ({ output, id, state }) => {
    authListReply(null, output);
    expect((await new ProviderAccountBindingService().checkBinding(profile('opencode', id))).state).toBe(state);
    if (state === 'authenticated') {
      expect(await materializeWorkerAccountRoute('opencode', { provider: 'opencode', profileId: id, region: 'ams' }))
        .toEqual({ provider: 'opencode', profileId: id, source: 'persisted', executionNodeId: 'worker', region: 'ams' });
    } else {
      await expect(materializeWorkerAccountRoute('opencode', { provider: 'opencode', profileId: id, region: 'ams' }))
        .rejects.toThrow(/cannot run on this node/);
    }
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCode/MiMo binding', () => {
  it('authenticates an account whose derived provider name is listed, and resolves no home', async () => {
    openCodeAuthList = AUTH_LIST_TWO;
    const bindings = service();
    expect(await bindings.checkBinding(profile('opencode', 'max-b-1a2b'))).toMatchObject({ state: 'authenticated' });
    // Legacy matches the region display name too (probe P3).
    expect(await bindings.checkBinding(profile('opencode', 'legacy'))).toMatchObject({ state: 'authenticated' });
  });

  it('reports unauthenticated when the account has no key listed', async () => {
    openCodeAuthList = AUTH_LIST_TWO;
    expect(await service().checkBinding(profile('opencode', 'max-c-2b3c'))).toMatchObject({
      state: 'unauthenticated',
      errorCode: 'no-auth',
    });
  });

  it('is unavailable when auth list cannot be read or is unrecognisable', async () => {
    openCodeAuthList = null;
    expect(await service().checkBinding(profile('opencode', 'max-b-1a2b'))).toMatchObject({
      state: 'unavailable',
      errorCode: 'auth-list-unreadable',
    });
    openCodeAuthList = 'Error: unknown command';
    expect(await service().checkBinding(profile('opencode', 'max-b-1a2b'))).toMatchObject({
      state: 'unavailable',
      errorCode: 'unexpected-output',
    });
  });

  it('is unavailable for a profile with no Token Plan region', async () => {
    openCodeAuthList = AUTH_LIST_TWO;
    const noRegion = { ...profile('opencode', 'legacy') };
    delete noRegion.region;
    expect(await service().checkBinding(noRegion)).toMatchObject({ state: 'unavailable', errorCode: 'no-region' });
  });
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
