import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, RuntimeChangeRequest } from '../../../shared/types/instance.types';
import { previewRuntimeChange, type RuntimeChangePreviewDeps } from './runtime-change-preview';
import { planRuntimeContinuity } from './runtime-reconciler-plan';

const MIN = 60_000;
const NOW = 5_000_000_000;

/** The account pool's continuation policy, as execution reads it through the store. */
const pool = vi.hoisted(() => ({
  continuation: 'shared-store' as 'shared-store' | 'replay',
  askedFor: [] as string[],
}));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getPoolPolicy: (provider: string) => {
      pool.askedFor.push(provider);
      return { continuation: pool.continuation };
    },
  }),
}));

beforeEach(() => {
  pool.continuation = 'shared-store';
  pool.askedFor = [];
});

function makeInstance(patch: Partial<Instance> = {}): Instance {
  return {
    id: 'i1', provider: 'claude', status: 'idle', currentModel: 'claude-opus-4-7', reasoningEffort: 'high', yoloMode: false,
    lastActivity: NOW - 5 * MIN,
    contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true },
    outputBuffer: [{ id: 'u', type: 'user', content: 'hi', timestamp: 1 }, { id: 'a', type: 'assistant', content: 'hello', timestamp: 2 }],
    ...patch,
  } as unknown as Instance;
}

function preview(
  instance: Instance | undefined,
  request: RuntimeChangeRequest,
  adapter: unknown = { getRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false }) },
  extra: Partial<RuntimePreviewHarness> = {},
) {
  const deps: RuntimeChangePreviewDeps = {
    getInstance: () => instance,
    getAdapter: () => adapter,
    getCacheLifetimeMs: () => null,
    now: () => NOW,
    ...extra,
  };
  return previewRuntimeChange(deps, 'i1', request);
}
type RuntimePreviewHarness = Pick<RuntimeChangePreviewDeps, 'getCacheLifetimeMs'>;

describe('previewRuntimeChange: Claude replays, so the new session gets a short summary', () => {
  it('describes a model change with the sizes and the target window', () => {
    const note = preview(makeInstance(), { model: 'claude-sonnet-4-6' });
    expect(note).toMatchObject({ kind: 'model', resendTokens: null });
    expect(note?.text).toMatch(/^Switching model starts a new session with a short summary of this one/);
    expect(note?.text).toContain('of the 230K tokens here');
    expect(note?.text).toContain("Claude's");
  });

  it('asks first when the new session would leave a large part of the conversation behind', () => {
    expect(preview(makeInstance(), { model: 'claude-sonnet-4-6' })).toMatchObject({ large: true });
    // 60K tokens leave about 51K behind: worth saying, not worth a yes.
    const modest = makeInstance({ contextUsage: { used: 60_000, total: 1_000_000, percentage: 6, occupancyReported: true } });
    expect(preview(modest, { model: 'claude-sonnet-4-6' })).toMatchObject({ large: false });
  });

  it('describes an effort-only change the same way, because Claude replays it too', () => {
    const note = preview(makeInstance(), { model: 'claude-opus-4-7', reasoningEffort: 'max' });
    expect(note?.kind).toBe('reasoning');
    expect(note?.text).toMatch(/^Changing thinking effort starts a new session/);
  });

  it('says nothing for an auto-approve flip: Claude keeps the conversation then', () => {
    expect(preview(makeInstance(), { model: 'claude-opus-4-7', yoloMode: true })).toBeNull();
  });

  it('waits for a running reply to finish', () => {
    const note = preview(makeInstance({ status: 'busy' }), { model: 'claude-sonnet-4-6' });
    expect(note?.text.startsWith('Once the current reply finishes, switching model')).toBe(true);
  });
});

describe('previewRuntimeChange: providers that resume read the whole conversation again', () => {
  const codex = (patch: Partial<Instance> = {}) => makeInstance({ provider: 'codex', currentModel: 'gpt-6-astra', ...patch });

  it('asks first about a large re-read on a model change', () => {
    const note = preview(codex(), { model: 'gpt-6.1-sol' });
    expect(note).toMatchObject({ kind: 'model', large: true, resendTokens: 230_000 });
    expect(note?.text).toBe('Switching model restarts this session, and the next message will re-read about 230K tokens at full price.');
  });

  it('does not ask for a small session', () => {
    const note = preview(codex({ contextUsage: { used: 60_000, total: 1_000_000, percentage: 6, occupancyReported: true } }), { model: 'gpt-6.1-sol' });
    expect(note).toMatchObject({ large: false, resendTokens: 60_000 });
  });

  it('describes a replay instead when the adapter cannot resume (a Codex session on another machine)', () => {
    const remote = { getRuntimeCapabilities: () => ({ supportsResume: false, supportsForkSession: false }) };
    const note = preview(codex(), { model: 'gpt-6.1-sol' }, remote);
    expect(note?.text).toMatch(/^Switching model starts a new session with a short summary/);
    expect(note?.large).toBe(true); // the replay leaves about 221K tokens behind
  });

  it('describes a provider switch as a replay onto the target, whatever the adapter can do', () => {
    const note = preview(codex(), { provider: 'gemini', model: 'gemini-3-pro' });
    expect(note?.kind).toBe('provider');
    expect(note?.text).toMatch(/^Switching provider starts a new session with a short summary/);
    expect(note?.text).toContain("Gemini's");
  });
});

describe('previewRuntimeChange: quiet cases', () => {
  it('says nothing when the request matches the live session, the session is gone, or no process is running', () => {
    expect(preview(makeInstance(), { model: 'claude-opus-4-7', reasoningEffort: 'high' })).toBeNull();
    expect(preview(undefined, { model: 'x' })).toBeNull();
    expect(preview(makeInstance(), { model: 'claude-sonnet-4-6' }, null)).toBeNull();
  });

  it('warns about replay for small conversations, because message-level limits can still discard details', () => {
    const small = makeInstance({ contextUsage: { used: 4_000, total: 1_000_000, percentage: 0.4, occupancyReported: true } });
    expect(preview(small, { model: 'claude-sonnet-4-6' })).toMatchObject({ large: false, resendTokens: null });
    expect(preview(small, { model: 'claude-sonnet-4-6' })?.text).toContain('the rest does not carry over');
  });

  it('does not claim a re-read cost once the cache has already expired', () => {
    // The premise is a shared-store pool, where the conversation is kept.
    pool.continuation = 'shared-store';
    const account = { model: 'claude-opus-4-7', accountProfileId: 'other-account' };
    expect(preview(makeInstance(), account)?.kind).toBe('account');
    const cold = makeInstance({ lastActivity: NOW - 3 * 60 * MIN });
    expect(preview(cold, account)).toBeNull();
    // A measured 5 minute cache has expired after 10 minutes, where the assumed hour would not have.
    const tenMinutes = makeInstance({ lastActivity: NOW - 10 * MIN });
    expect(preview(tenMinutes, account, undefined, { getCacheLifetimeMs: () => 5 * MIN })).toBeNull();
    expect(preview(tenMinutes, account)?.kind).toBe('account');
  });
});

describe('previewRuntimeChange: an account handoff follows the pool continuation policy', () => {
  const account = { model: 'claude-opus-4-7', accountProfileId: 'other-account' };

  it('warns that the conversation is discarded on a replay pool, even when the cache is cold', () => {
    pool.continuation = 'replay';
    const cold = makeInstance({ lastActivity: NOW - 3 * 60 * MIN });
    const note = preview(cold, account);
    expect(pool.askedFor).toContain('claude');
    expect(note).toMatchObject({ kind: 'account', large: true });
    expect(note?.text).toMatch(/short summary/);
    expect(note?.text).toContain('the rest does not carry over');
  });

  it('keeps the quiet re-read rule on a shared-store pool', () => {
    pool.continuation = 'shared-store';
    const cold = makeInstance({ lastActivity: NOW - 3 * 60 * MIN });
    expect(preview(cold, account)).toBeNull();
    expect(preview(makeInstance(), account)).toMatchObject({ kind: 'account', resendTokens: 230_000 });
  });

  it.each(['claude', 'codex', 'copilot'] as const)('warns about the %s account replay when auto-approve changes too', provider => {
    pool.continuation = 'replay';
    for (const enable of [true, false]) {
      const instance = makeInstance({ provider, yoloMode: !enable, accountProfileId: 'account-a', copilotAccountProfileId: 'seat-a' });
      const request = provider === 'copilot' ? { copilotAccountProfileId: 'seat-b', yoloMode: enable }
        : { accountProfileId: 'account-b', yoloMode: enable };
      const note = preview(instance, request);
      expect(note).toMatchObject({ large: true, resendTokens: null });
      expect(note?.text).toContain('the rest does not carry over');
    }
  });
});

describe('planRuntimeContinuity', () => {
  const caps = { supportsResume: true, supportsForkSession: true };
  const flags = {
    providerChanged: false, modelChanged: false, reasoningChanged: false, runtimeTargetChanged: false,
    yoloModeChanged: false, copilotAccountChanged: false, accountProfileChanged: false, hasChanges: true,
  };
  const base = { capabilities: caps, hasConversation: true, cliType: 'claude' as const, isLocalModelTarget: false };

  it('keeps the conversation for a permission-only change, even on Claude', () => {
    expect(planRuntimeContinuity({ ...base, diff: { ...flags, yoloModeChanged: true } })).toBe('native-resume-fork');
    expect(planRuntimeContinuity({ ...base, capabilities: { ...caps, supportsForkSession: false }, diff: { ...flags, yoloModeChanged: true } })).toBe('native-resume');
    expect(planRuntimeContinuity({ ...base, hasConversation: false, diff: { ...flags, yoloModeChanged: true } })).toBe('replay');
  });

  it('still replays any Claude change that touches the model or effort', () => {
    expect(planRuntimeContinuity({ ...base, diff: { ...flags, modelChanged: true, yoloModeChanged: true } })).toBe('replay');
    expect(planRuntimeContinuity({ ...base, diff: { ...flags, reasoningChanged: true } })).toBe('replay');
  });
});
