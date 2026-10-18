import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAuthRepairCommunicationCallbacks, probeInstanceAccountAuth, switchAccountAfterSignOut } from './instance-auth-repair-runtime';
import { getInstanceAuthRepairHandler, _resetInstanceAuthRepairHandlerForTesting } from './instance-auth-repair-handler';
import type { Instance } from '../../shared/types/instance.types';
import type { AccountBindingState, ProviderAccountProfile } from '../../shared/types/provider-account.types';
import type { AccountFailoverOutcome } from '../providers/account-pool/account-failover-coordinator';

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i1',
    provider: 'claude',
    currentModel: 'opus',
    accountProfileId: 'claudecomtech-7e12',
    ...overrides,
  } as Instance;
}

const comtech = { id: 'claudecomtech-7e12', provider: 'claude', label: 'Comtech' } as ProviderAccountProfile;

describe('probeInstanceAccountAuth', () => {
  const probeDefault = vi.fn(async () => 'authenticated' as const);
  const checkBinding = vi.fn(async (_profile: ProviderAccountProfile, _node: string, _options: { force?: boolean }) =>
    ({ state: 'unauthenticated' as AccountBindingState }));
  const getProfile = vi.fn((_provider: string, _id: string) => comtech as ProviderAccountProfile | null);
  const deps = {
    probeDefault,
    store: () => ({ getProfile }),
    bindings: () => ({ checkBinding }),
  } as unknown as Parameters<typeof probeInstanceAccountAuth>[2];

  beforeEach(() => {
    vi.clearAllMocks();
    getProfile.mockReturnValue(comtech);
  });

  it('checks the session\'s own pooled account with a fresh (uncached) binding check', async () => {
    await expect(probeInstanceAccountAuth('claude', instance(), deps)).resolves.toBe('unauthenticated');

    expect(getProfile).toHaveBeenCalledWith('claude', 'claudecomtech-7e12');
    expect(checkBinding).toHaveBeenCalledWith(comtech, 'local', { force: true });
    expect(probeDefault).not.toHaveBeenCalled();
  });

  it('treats an unstamped Claude session as the legacy account', async () => {
    await probeInstanceAccountAuth('claude', instance({ accountProfileId: undefined }), deps);

    expect(getProfile).toHaveBeenCalledWith('claude', 'legacy');
  });

  it.each([
    ['authenticated', 'authenticated'],
    ['unauthenticated', 'unauthenticated'],
    ['identity-mismatch', 'unauthenticated'],
    ['unavailable', 'unknown'],
  ] as const)('maps binding state %s to %s', async (binding, expected) => {
    checkBinding.mockResolvedValueOnce({ state: binding });

    await expect(probeInstanceAccountAuth('claude', instance(), deps)).resolves.toBe(expected);
  });

  it('keeps the default probe for remote sessions, unknown profiles and unpooled providers', async () => {
    await probeInstanceAccountAuth('claude', instance({ executionLocation: { type: 'remote', nodeId: 'n1' } } as Partial<Instance>), deps);
    getProfile.mockReturnValueOnce(null);
    await probeInstanceAccountAuth('claude', instance(), deps);
    await probeInstanceAccountAuth('gemini', instance({ provider: 'gemini' }), deps);

    expect(probeDefault).toHaveBeenCalledTimes(3);
    expect(checkBinding).not.toHaveBeenCalled();
  });
});

describe('switchAccountAfterSignOut', () => {
  const perform = vi.fn(async (): Promise<AccountFailoverOutcome> => ({
    outcome: 'switched', toProfileId: 'legacy', continuity: 'native-resume',
  }));
  const emitSystemMessage = vi.fn();
  const params = {
    instanceId: 'i1',
    provider: 'claude' as const,
    reason: 'provider protocol reported auth failure: OAuth token revoked',
    resumeTurn: { message: 'continue the migration' },
  };

  function deps(current: Instance | null = instance()) {
    return { getInstance: () => current ?? undefined, emitSystemMessage, coordinator: () => ({ perform }) };
  }

  beforeEach(() => vi.clearAllMocks());

  it('asks the account failover to move the session off the signed-out account and re-send the turn', async () => {
    await expect(switchAccountAfterSignOut(params, deps())).resolves.toBe(true);

    expect(perform).toHaveBeenCalledWith({
      instanceId: 'i1',
      provider: 'claude',
      model: 'opus',
      exhaustedProfileId: 'claudecomtech-7e12',
      resumeAt: null,
      resumePrompt: 'continue the migration',
      reason: params.reason,
      trigger: 'signed-out',
    });
  });

  it.each([
    [{ outcome: 'not-switched', reason: 'no-candidate', considered: [] }],
    [{ outcome: 'not-switched', reason: 'cooldown', considered: [] }],
    [{ outcome: 'offered', toProfileId: 'legacy' }],
  ] as const)('leaves the banner to the caller when the session did not move (%o)', async (outcome) => {
    perform.mockResolvedValueOnce(outcome as AccountFailoverOutcome);

    await expect(switchAccountAfterSignOut(params, deps())).resolves.toBe(false);
  });

  it('tells the user to resend when a concurrent switch already moved the session without this turn', async () => {
    perform.mockResolvedValueOnce({ outcome: 'already-moved', toProfileId: 'legacy', turnNotSent: true });

    await expect(switchAccountAfterSignOut(params, deps())).resolves.toBe(true);

    expect(emitSystemMessage).toHaveBeenCalledWith('i1', expect.stringContaining('Send it again'), expect.objectContaining({ accountFailover: true }));
  });

  it('does nothing for an unpooled provider, a missing instance, or before the coordinator exists', async () => {
    await expect(switchAccountAfterSignOut(params, deps(instance({ provider: 'gemini' })))).resolves.toBe(false);
    await expect(switchAccountAfterSignOut(params, deps(null))).resolves.toBe(false);
    await expect(switchAccountAfterSignOut(params, { ...deps(), coordinator: () => null })).resolves.toBe(false);

    expect(perform).not.toHaveBeenCalled();
  });
});

describe('createAuthRepairCommunicationCallbacks', () => {
  beforeEach(() => _resetInstanceAuthRepairHandlerForTesting());

  it('reports a failure as stale once the session has moved off the account it failed on', async () => {
    const live = instance({ accountProfileId: 'claudecomtech-7e12' });
    const maybeBlock = vi.spyOn(getInstanceAuthRepairHandler(), 'maybeBlockOnAuth').mockResolvedValue('skipped');
    const { onAuthFailureTurn } = createAuthRepairCommunicationCallbacks(() => live);

    onAuthFailureTurn?.({ instanceId: 'i1', reason: 'OAuth token revoked', resumeTurn: null, authoritative: true });
    const { stillCurrent } = maybeBlock.mock.calls[0][0];

    expect(stillCurrent?.()).toBe(true);
    live.accountProfileId = 'legacy';
    expect(stillCurrent?.()).toBe(false);
  });

  it('treats an unstamped session and the legacy account as the same account', () => {
    const live = instance({ accountProfileId: undefined });
    const maybeBlock = vi.spyOn(getInstanceAuthRepairHandler(), 'maybeBlockOnAuth').mockResolvedValue('skipped');
    const { onAuthFailureTurn } = createAuthRepairCommunicationCallbacks(() => live);

    onAuthFailureTurn?.({ instanceId: 'i1', reason: 'OAuth token revoked', resumeTurn: null, authoritative: true });
    live.accountProfileId = 'legacy';

    expect(maybeBlock.mock.calls[0][0].stillCurrent?.()).toBe(true);
  });
});
