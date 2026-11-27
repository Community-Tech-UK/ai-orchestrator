import { describe, expect, it, vi } from 'vitest';
import type { AccountTrialOperations } from '../../shared/types/account-trial.types';
import {
  createAccountTrialForwarderTools,
  createAccountTrialToolDefinitions,
} from './orchestrator-account-trial-tools';

function wired(instanceId: string | null = 'inst-7') {
  const accountTrial: { [K in keyof AccountTrialOperations]: ReturnType<typeof vi.fn> } = {
    reserve: vi.fn(() => ({ leaseId: 'l1', expiresAt: 5, profiles: [] })),
    startSession: vi.fn(async () => ({ instanceId: 'arm-1', leaseId: 'l1' })),
    release: vi.fn(async () => ({ leaseId: 'l1', reason: 'released', complete: true, profiles: [], sessions: [] })),
    status: vi.fn(() => ({ leases: [], otherActiveLeases: 0 })),
  };
  const [tool] = createAccountTrialToolDefinitions({ instanceId, accountTrial: accountTrial as unknown as AccountTrialOperations });
  return { tool: tool!, accountTrial };
}

describe('account_trial tool', () => {
  it('describes what it can and cannot do', () => {
    const { tool } = wired();
    expect(tool.name).toBe('account_trial');
    expect(tool.description).toMatch(/manual-only/);
    expect(tool.description).toMatch(/Never creates, signs in, enables or removes an account/);
    expect(tool.description).toMatch(/legacy/);
  });

  it('passes the calling session as the owner and each action\'s arguments through', async () => {
    const { tool, accountTrial } = wired('inst-7');
    await tool.handler({ action: 'reserve', profiles: [{ provider: 'claude', profileId: 'legacy' }], ttlMinutes: 30 });
    expect(accountTrial.reserve).toHaveBeenCalledWith('inst-7', { profiles: [{ provider: 'claude', profileId: 'legacy' }], ttlMinutes: 30 });
    await tool.handler({ action: 'reserve', profiles: [{ provider: 'codex', profileId: 'legacy' }] });
    expect(accountTrial.reserve).toHaveBeenLastCalledWith('inst-7', { profiles: [{ provider: 'codex', profileId: 'legacy' }] });
    await tool.handler({
      action: 'start_session', leaseId: 'l1', provider: 'claude', profileId: 'legacy', prompt: 'go', model: ' m ', workingDirectory: '/tmp/arm', name: ' A ',
    });
    expect(accountTrial.startSession).toHaveBeenCalledWith('inst-7', {
      leaseId: 'l1', provider: 'claude', profileId: 'legacy', prompt: 'go', model: 'm', workingDirectory: '/tmp/arm', name: 'A',
    });
    await tool.handler({ action: 'release', leaseId: 'l1' });
    expect(accountTrial.release).toHaveBeenCalledWith('inst-7', 'l1');
    await tool.handler({ action: 'status' });
    expect(accountTrial.status).toHaveBeenCalledWith('inst-7');
  });

  it('rejects unknown actions, extra keys, a smuggled owner, policy values and bad shapes', async () => {
    const { tool, accountTrial } = wired();
    const bad: unknown[] = [
      {},
      { action: 'delete' },
      { action: 'status', ownerInstanceId: 'someone-else' },
      { action: 'reserve', profiles: [] },
      { action: 'reserve', profiles: [{ provider: 'claude', profileId: 'legacy' }], policy: 'allow-routed' },
      { action: 'reserve', profiles: [{ provider: 'claude', profileId: 'legacy', automationPolicy: 'allow-routed' }] },
      { action: 'reserve', profiles: [{ provider: 'gemini', profileId: 'legacy' }] },
      { action: 'reserve', profiles: [{ provider: 'claude', profileId: '../etc' }] },
      { action: 'reserve', profiles: Array.from({ length: 7 }, (_, i) => ({ provider: 'claude', profileId: `p${i}` })) },
      { action: 'reserve', profiles: [{ provider: 'claude', profileId: 'legacy' }], ttlMinutes: 721 },
      { action: 'reserve', profiles: [{ provider: 'claude', profileId: 'legacy' }], ttlMinutes: 1.5 },
      { action: 'start_session', leaseId: 'l1', provider: 'claude', profileId: 'legacy' },
      { action: 'start_session', leaseId: 'l1', provider: 'claude', profileId: 'legacy', prompt: '' },
      { action: 'start_session', leaseId: 'l1', provider: 'claude', profileId: 'legacy', prompt: 'x', workingDirectory: 'relative/dir' },
      { action: 'start_session', leaseId: 'l1', provider: 'claude', profileId: 'legacy', prompt: 'x', yoloMode: true },
      { action: 'release' },
      { action: 'release', leaseId: '' },
    ];
    for (const args of bad) await expect(tool.handler(args as Record<string, unknown>)).rejects.toThrow();
    for (const fn of Object.values(accountTrial)) expect(fn).not.toHaveBeenCalled();
  });

  it('is unavailable without the lease service or without a caller id', async () => {
    const [unwired] = createAccountTrialToolDefinitions({ instanceId: 'inst-7', accountTrial: null });
    await expect(unwired!.handler({ action: 'status' })).rejects.toThrow(/not wired/);
    const { tool } = wired(null);
    await expect(tool.handler({ action: 'status' })).rejects.toThrow(/could not be identified/);
  });

  it('forwards to the Harness process over the same-name RPC method', async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const [forwarded] = createAccountTrialForwarderTools({ call });
    expect(forwarded!.name).toBe('account_trial');
    await forwarded!.handler({ action: 'status' });
    expect(call).toHaveBeenCalledWith('orchestrator_tools.account_trial', { action: 'status' });
    await expect(forwarded!.handler([] as never)).rejects.toThrow(/must be an object/);
  });
});
