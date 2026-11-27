import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  userData: '',
  profiles: [] as Array<{ provider: string; id: string; label: string; automationPolicy: string }>,
  createInstanceWithMessage: vi.fn(),
  cleanups: [] as Array<() => void | Promise<void>>,
}));

vi.mock('electron', () => ({ app: { getPath: () => h.userData } }));
vi.mock('../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getProfile: (provider: string, id: string) => h.profiles.find((p) => p.provider === provider && p.id === id) ?? null,
    updateProfile: (provider: string, id: string, input: { automationPolicy: string }) => {
      const target = h.profiles.find((p) => p.provider === provider && p.id === id)!;
      target.automationPolicy = input.automationPolicy;
    },
  }),
}));
vi.mock('../ipc/handlers/instance-create-with-message', () => ({ createInstanceWithMessage: h.createInstanceWithMessage }));
vi.mock('../util/cleanup-registry', () => ({ registerCleanup: (fn: () => void | Promise<void>) => { h.cleanups.push(fn); return () => undefined; } }));

import { startAccountTrial } from './account-trial-wiring';

type FakeInstance = { status: string; workingDirectory?: string; readyPromise?: Promise<void> };
function manager(instances: Record<string, FakeInstance>) {
  return {
    getInstance: (id: string) => instances[id],
    terminateInstance: vi.fn(async (id: string) => { delete instances[id]; }),
  };
}

describe('startAccountTrial', () => {
  beforeEach(() => {
    h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-trial-wiring-'));
    h.profiles = [{ provider: 'claude', id: 'legacy', label: 'ClaudeSUAS', automationPolicy: 'disabled' }];
    h.createInstanceWithMessage.mockReset();
    h.cleanups.length = 0;
  });
  afterEach(() => fs.rmSync(h.userData, { recursive: true, force: true }));

  it('starts the chat on the named account in the caller\'s folder and stops it on release', async () => {
    const instances: Record<string, FakeInstance> = { owner: { status: 'idle', workingDirectory: '/work/trial' } };
    const im = manager(instances);
    h.createInstanceWithMessage.mockImplementation(async () => {
      instances['arm-1'] = { status: 'busy', readyPromise: Promise.resolve() };
      return { success: true, data: { id: 'arm-1' } };
    });
    const trial = await startAccountTrial(im as never);
    const { leaseId } = trial.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    expect(h.profiles[0]?.automationPolicy).toBe('manual-only');

    await expect(trial.startSession('owner', { leaseId, provider: 'claude', profileId: 'legacy', prompt: 'go', name: 'arm A' }))
      .resolves.toEqual({ instanceId: 'arm-1', leaseId });
    expect(h.createInstanceWithMessage).toHaveBeenCalledWith(
      im, { message: 'go', provider: 'claude', accountProfileId: 'legacy', displayName: 'arm A' }, '/work/trial', undefined,
    );

    const receipt = await trial.release('owner', leaseId);
    expect(receipt.sessions).toEqual([{ instanceId: 'arm-1', stopped: true }]);
    expect(im.terminateInstance).toHaveBeenCalledWith('arm-1');
    expect(h.profiles[0]?.automationPolicy).toBe('disabled');
  });

  it('asks for a folder when the caller has none, and surfaces a refused route', async () => {
    const trial = await startAccountTrial(manager({ owner: { status: 'idle' } }) as never);
    const { leaseId } = trial.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    await expect(trial.startSession('owner', { leaseId, provider: 'claude', profileId: 'legacy', prompt: 'go' })).rejects.toThrow(/Pass workingDirectory/);
    h.createInstanceWithMessage.mockRejectedValue(new Error('The ClaudeSUAS account is not signed in.'));
    await expect(trial.startSession('owner', { leaseId, provider: 'claude', profileId: 'legacy', prompt: 'go', workingDirectory: '/w' }))
      .rejects.toThrow(/not signed in/);
    expect(trial.status('owner').leases).toHaveLength(1);
  });

  it('turns a refused account route, which only fails in the background start, into an error and stops that session', async () => {
    const instances: Record<string, FakeInstance> = { owner: { status: 'idle', workingDirectory: '/w' } };
    const im = manager(instances);
    h.createInstanceWithMessage.mockImplementation(async () => {
      const readyPromise = Promise.reject(new Error('The ClaudeSUAS account is not signed in.'));
      readyPromise.catch(() => undefined);
      instances['arm-1'] = { status: 'failed', readyPromise };
      return { success: true, data: { id: 'arm-1' } };
    });
    const trial = await startAccountTrial(im as never);
    const { leaseId } = trial.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    await expect(trial.startSession('owner', { leaseId, provider: 'claude', profileId: 'legacy', prompt: 'go' }))
      .rejects.toThrow(/could not start on that account: The ClaudeSUAS account is not signed in/);
    expect(im.terminateInstance).toHaveBeenCalledWith('arm-1');
    const status = trial.status('owner');
    expect(status.leases[0]?.sessionIds).toEqual([]);
    expect(h.profiles[0]?.automationPolicy).toBe('manual-only');
  });

  it('also refuses a session that finished starting already marked failed', async () => {
    const instances: Record<string, FakeInstance> = { owner: { status: 'idle', workingDirectory: '/w' } };
    const im = manager(instances);
    h.createInstanceWithMessage.mockImplementation(async () => {
      instances['arm-1'] = { status: 'failed' };
      return { success: true, data: { id: 'arm-1' } };
    });
    const trial = await startAccountTrial(im as never);
    const { leaseId } = trial.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    await expect(trial.startSession('owner', { leaseId, provider: 'claude', profileId: 'legacy', prompt: 'go' })).rejects.toThrow(/failed while starting/);
    expect(im.terminateInstance).toHaveBeenCalledWith('arm-1');
  });

  it('ends leases a crashed run left behind, before serving any call', async () => {
    const first = await startAccountTrial(manager({ owner: { status: 'idle' } }) as never);
    first.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    expect(h.profiles[0]?.automationPolicy).toBe('manual-only');
    const second = await startAccountTrial(manager({}) as never);
    expect(h.profiles[0]?.automationPolicy).toBe('disabled');
    expect(second.status('owner').leases).toEqual([]);
  });

  it('puts policies back at shutdown', async () => {
    const trial = await startAccountTrial(manager({ owner: { status: 'idle' } }) as never);
    trial.reserve('owner', { profiles: [{ provider: 'claude', profileId: 'legacy' }] });
    for (const cleanup of h.cleanups) await cleanup();
    expect(h.profiles[0]?.automationPolicy).toBe('disabled');
  });
});
