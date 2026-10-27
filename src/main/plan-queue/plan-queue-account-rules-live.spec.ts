import { describe, expect, it, vi } from 'vitest';
import type { PlanQueueAccountRules } from '@contracts/schemas/plan-queue';
import { applyLiveAccountRules, sessionOnNeverUse, type LiveQueueSession } from './plan-queue-account-rules-live';

const rules = (never: PlanQueueAccountRules['never'] = [], last: PlanQueueAccountRules['last'] = []): PlanQueueAccountRules => ({ never, last });

function fakeHost(sessions: LiveQueueSession[]) {
  return {
    liveSessions: vi.fn(() => sessions),
    setPreferences: vi.fn(),
    holdSession: vi.fn(async (_instanceId: string, _reason: string) => undefined),
    requestPump: vi.fn(),
  };
}

describe('sessionOnNeverUse', () => {
  it('matches a pool account by provider and profile id', () => {
    const r = rules([{ provider: 'claude', accountId: 'suas' }]);
    expect(sessionOnNeverUse({ id: 's', provider: 'claude', accountProfileId: 'suas' }, r)).toBe(true);
    expect(sessionOnNeverUse({ id: 's', provider: 'codex', accountProfileId: 'suas' }, r)).toBe(false);
  });

  it('reads a Copilot session by its Copilot profile, not its pool profile', () => {
    const r = rules([{ provider: 'copilot', accountId: 'work' }]);
    expect(sessionOnNeverUse({ id: 's', provider: 'copilot', copilotAccountProfileId: 'work' }, r)).toBe(true);
    expect(sessionOnNeverUse({ id: 's', provider: 'copilot', accountProfileId: 'work' }, r)).toBe(false);
  });

  it('is false for a use-last account and for a session with no provider', () => {
    const r = rules([], [{ provider: 'claude', accountId: 'suas' }]);
    expect(sessionOnNeverUse({ id: 's', provider: 'claude', accountProfileId: 'suas' }, r)).toBe(false);
    expect(sessionOnNeverUse({ id: 's', accountProfileId: 'suas' }, rules([{ provider: 'claude', accountId: 'suas' }]))).toBe(false);
  });
});

describe('applyLiveAccountRules', () => {
  it('gives every live session the lists for its provider, and holds only the ones on a never-use account', async () => {
    const r = rules([{ provider: 'claude', accountId: 'suas' }], [{ provider: 'codex', accountId: 'pro-2' }]);
    const host = fakeHost([
      { id: 'banned', provider: 'claude', accountProfileId: 'suas' },
      { id: 'ok', provider: 'claude', accountProfileId: 'other' },
      { id: 'codex', provider: 'codex', accountProfileId: 'pro-2' },
    ]);
    await applyLiveAccountRules(r, host);
    expect(host.setPreferences).toHaveBeenCalledWith('banned', { avoid: ['suas'], last: [] });
    expect(host.setPreferences).toHaveBeenCalledWith('ok', { avoid: ['suas'], last: [] });
    expect(host.setPreferences).toHaveBeenCalledWith('codex', { avoid: [], last: ['pro-2'] });
    expect(host.holdSession).toHaveBeenCalledTimes(1);
    expect(host.holdSession).toHaveBeenCalledWith('banned', expect.stringContaining('never-use'));
    expect(host.requestPump).toHaveBeenCalledTimes(1);
  });

  it('stops nothing when a use-last rule is added, and clears preferences that are no longer set', async () => {
    const host = fakeHost([{ id: 's', provider: 'claude', accountProfileId: 'suas', accountPreferences: { avoid: ['old'], last: [] } }]);
    await applyLiveAccountRules(rules([], [{ provider: 'claude', accountId: 'suas' }]), host);
    expect(host.setPreferences).toHaveBeenCalledWith('s', { avoid: [], last: ['suas'] });
    expect(host.holdSession).not.toHaveBeenCalled();
    expect(host.requestPump).not.toHaveBeenCalled();

    const cleared = fakeHost([{ id: 's', provider: 'claude', accountProfileId: 'suas', accountPreferences: { avoid: ['old'], last: [] } }]);
    await applyLiveAccountRules(rules(), cleared);
    expect(cleared.setPreferences).toHaveBeenCalledWith('s', undefined);
  });

  it('does not rewrite preferences that already match', async () => {
    const host = fakeHost([{ id: 's', provider: 'claude', accountProfileId: 'other', accountPreferences: { avoid: ['suas'], last: [] } }]);
    await applyLiveAccountRules(rules([{ provider: 'claude', accountId: 'suas' }]), host);
    expect(host.setPreferences).not.toHaveBeenCalled();
  });

  it('waits for every hold before requesting the restart, then reports the failed one', async () => {
    let finishLate!: () => void;
    const late = new Promise<void>((resolve) => { finishLate = resolve; });
    const host = fakeHost([
      { id: 'fails', provider: 'claude', accountProfileId: 'suas' },
      { id: 'late', provider: 'claude', accountProfileId: 'suas' },
    ]);
    host.holdSession.mockImplementation(async (instanceId: string) => {
      if (instanceId === 'fails') throw new Error('item busy');
      await late;
    });
    const applied = applyLiveAccountRules(rules([{ provider: 'claude', accountId: 'suas' }]), host);
    await vi.waitFor(() => expect(host.holdSession).toHaveBeenCalledTimes(2));
    expect(host.requestPump).not.toHaveBeenCalled();
    finishLate();
    await expect(applied).rejects.toThrow('item busy');
    expect(host.requestPump).toHaveBeenCalledTimes(1);
  });

  it('holds each banned session, not the others, and waits for every hold', async () => {
    const r = rules([{ provider: 'claude', accountId: 'suas' }]);
    const host = fakeHost([
      { id: 'a', provider: 'claude', accountProfileId: 'suas' },
      { id: 'b', provider: 'claude', accountProfileId: 'suas' },
    ]);
    await applyLiveAccountRules(r, host);
    expect(host.holdSession.mock.calls.map((call) => call[0])).toEqual(['a', 'b']);
  });
});
