import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountProfile } from '../shared/types/provider-account.types';
import {
  WORKER_SIGN_IN_CACHE_MS,
  getCachedWorkerSignIns,
  refreshWorkerSignIns,
  resetWorkerSignInsForTesting,
} from './worker-sign-ins';

function status(profile: ProviderAccountProfile, state: AccountBindingStatus['state'], observedIdentity?: string): AccountBindingStatus {
  return {
    provider: profile.provider, profileId: profile.id, nodeId: 'worker', state, checkedAt: 0,
    ...(observedIdentity ? { observedIdentity } : {}),
  };
}

describe('worker sign-ins', () => {
  afterEach(() => resetWorkerSignInsForTesting());

  it('checks each installed tool\'s default sign-in and its profiles, with no expected identity, and says what it found', async () => {
    const seen: string[] = [];
    const checkBinding = vi.fn(async (profile: ProviderAccountProfile) => {
      seen.push(`${profile.provider}:${profile.id}:${String(profile.expectedIdentity)}:${profile.isLegacy}`);
      if (profile.provider === 'claude' && profile.id === 'legacy') return status(profile, 'authenticated', 'person@example.invalid');
      if (profile.provider === 'claude') return status(profile, 'unavailable');
      return status(profile, 'unauthenticated');
    });
    const result = await refreshWorkerSignIns({
      supportedClis: ['claude', 'codex', 'copilot'],
      accountProfileIds: { claude: ['work'], codex: [], opencode: ['mimo'] },
    }, { checkBinding });
    expect(seen).toEqual(['claude:legacy:null:true', 'claude:work:null:false', 'codex:legacy:null:true']);
    expect(result).toEqual([
      { provider: 'claude', profileId: 'legacy', state: 'signed-in', identity: 'person@example.invalid' },
      { provider: 'claude', profileId: 'work', state: 'unknown' },
      { provider: 'codex', profileId: 'legacy', state: 'signed-out' },
    ]);
  });

  it('skips a tool that is not installed, and reads a check that throws as unknown', async () => {
    const checkBinding = vi.fn(async () => { throw new Error('spawn failed'); });
    const result = await refreshWorkerSignIns({ supportedClis: ['codex'], accountProfileIds: { claude: ['work'] } }, { checkBinding });
    expect(result).toEqual([{ provider: 'codex', profileId: 'legacy', state: 'unknown' }]);
  });

  it('reads a check that never finishes as unknown, so later refreshes still run', async () => {
    const checkBinding = vi.fn((profile: ProviderAccountProfile) => (profile.provider === 'claude'
      ? new Promise<AccountBindingStatus>(() => undefined)
      : Promise.resolve(status(profile, 'authenticated'))));
    const result = await refreshWorkerSignIns({ supportedClis: ['claude', 'codex'], accountProfileIds: {} }, { checkBinding, checkLimitMs: 5 });
    expect(result).toEqual([
      { provider: 'claude', profileId: 'legacy', state: 'unknown' },
      { provider: 'codex', profileId: 'legacy', state: 'signed-in' },
    ]);
  });

  it('never waits: nothing before the first check, then the result until it is ten minutes old', async () => {
    let now = 1_000;
    const checkBinding = vi.fn(async (profile: ProviderAccountProfile) => status(profile, 'authenticated'));
    const input = { supportedClis: ['codex'], accountProfileIds: {} };
    const deps = { checkBinding, now: () => now };

    expect(getCachedWorkerSignIns(input, deps)).toBeUndefined();
    await refreshWorkerSignIns(input, deps); // joins the check the first call started
    expect(checkBinding).toHaveBeenCalledTimes(1);
    expect(getCachedWorkerSignIns(input, deps)).toEqual([{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }]);
    expect(checkBinding).toHaveBeenCalledTimes(1);

    now += WORKER_SIGN_IN_CACHE_MS;
    expect(getCachedWorkerSignIns(input, deps)).toHaveLength(1);
    await vi.waitFor(() => expect(checkBinding).toHaveBeenCalledTimes(2));
  });

  it('checks again straight away when a new profile appears', async () => {
    const checkBinding = vi.fn(async (profile: ProviderAccountProfile) => status(profile, 'authenticated'));
    await refreshWorkerSignIns({ supportedClis: ['claude'], accountProfileIds: {} }, { checkBinding });
    const next = await refreshWorkerSignIns({ supportedClis: ['claude'], accountProfileIds: { claude: ['work'] } }, { checkBinding });
    expect(next.map(entry => entry.profileId)).toEqual(['legacy', 'work']);
    expect(checkBinding).toHaveBeenCalledTimes(3);
  });

  it('keeps the newer result when an older check of fewer accounts finishes last', async () => {
    let finishOld: (() => void) | undefined;
    const checkBinding = vi.fn((profile: ProviderAccountProfile) => (profile.id === 'legacy' && !finishOld
      ? new Promise<AccountBindingStatus>(resolve => { finishOld = () => resolve(status(profile, 'unauthenticated')); })
      : Promise.resolve(status(profile, 'authenticated'))));
    const older = refreshWorkerSignIns({ supportedClis: ['codex'], accountProfileIds: {} }, { checkBinding });
    await refreshWorkerSignIns({ supportedClis: ['codex'], accountProfileIds: { codex: ['work'] } }, { checkBinding });
    finishOld!();
    await older;
    expect(getCachedWorkerSignIns({ supportedClis: ['codex'], accountProfileIds: { codex: ['work'] } }, { checkBinding }))
      .toEqual([
        { provider: 'codex', profileId: 'legacy', state: 'signed-in' },
        { provider: 'codex', profileId: 'work', state: 'signed-in' },
      ]);
  });

  it('sends an address only for Claude, whose own status names it', async () => {
    const checkBinding = vi.fn(async (profile: ProviderAccountProfile) => status(profile, 'authenticated', 'someone@example.invalid'));
    const result = await refreshWorkerSignIns({ supportedClis: ['codex'], accountProfileIds: {} }, { checkBinding });
    expect(result).toEqual([{ provider: 'codex', profileId: 'legacy', state: 'signed-in' }]);
  });
});
