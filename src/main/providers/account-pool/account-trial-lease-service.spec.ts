import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountAutomationPolicy,
  PooledProvider,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { AccountTrialLeaseService, type AccountTrialLeaseDeps } from './account-trial-lease-service';
import { ProviderAccountStore } from './provider-account-store';

function profile(provider: PooledProvider, id: string, label: string, automationPolicy: AccountAutomationPolicy): ProviderAccountProfile {
  return {
    id, provider, label, expectedIdentity: null, expectedAccountKey: null, planLabel: null, priority: 0,
    enabled: true, automationPolicy, isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

class FakeStore {
  readonly writes: Array<{ provider: PooledProvider; id: string; policy: AccountAutomationPolicy }> = [];
  failWritesFor: string | null = null;
  constructor(public profiles: ProviderAccountProfile[]) {}
  getProfile(provider: PooledProvider, id: string) {
    return this.profiles.find((p) => p.provider === provider && p.id === id) ?? null;
  }
  updateProfile(provider: PooledProvider, id: string, input: { automationPolicy: AccountAutomationPolicy }) {
    if (this.failWritesFor === `${provider}:${id}`) throw new Error('store refused the write');
    const target = this.getProfile(provider, id);
    if (!target) throw new Error('missing');
    target.automationPolicy = input.automationPolicy;
    this.writes.push({ provider, id, policy: input.automationPolicy });
  }
  policy(provider: PooledProvider, id: string) {
    return this.getProfile(provider, id)?.automationPolicy;
  }
}

describe('AccountTrialLeaseService', () => {
  let dir: string;
  let filePath: string;
  let store: FakeStore;
  let now: number;
  let live: Set<string>;
  let started: string[];
  let stopped: string[];
  let nextLease: number;
  let startError: Error | null;

  const deps = (): AccountTrialLeaseDeps => ({
    store,
    filePath,
    isInstanceLive: (id) => live.has(id),
    startSession: vi.fn(async (request) => {
      if (startError) throw startError;
      const instanceId = `arm-${started.length + 1}-${request.profileId}`;
      started.push(instanceId);
      return { instanceId };
    }),
    terminateSession: vi.fn(async (id) => { stopped.push(id); }),
    now: () => now,
    newLeaseId: () => `lease-${++nextLease}`,
  });
  const make = () => new AccountTrialLeaseService(deps());

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-trial-lease-'));
    filePath = path.join(dir, 'leases.json');
    store = new FakeStore([
      profile('claude', 'legacy', 'ClaudeSUAS', 'disabled'),
      profile('codex', 'legacy', 'CodexSUAS', 'allow-routed'),
      profile('opencode', 'subs-1a2b', 'subs', 'manual-only'),
      profile('claude', 'other-1111', 'Other', 'allow-routed'),
    ]);
    now = 1_000_000;
    live = new Set(['owner-1', 'owner-2']);
    started = [];
    stopped = [];
    nextLease = 0;
    startError = null;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const both = [{ provider: 'claude' as const, profileId: 'legacy' }, { provider: 'codex' as const, profileId: 'legacy' }];

  describe('reserve', () => {
    it('saves each policy, sets manual-only, and keeps the two legacy profiles apart by provider', () => {
      const service = make();
      const receipt = service.reserve('owner-1', { profiles: both });
      expect(receipt.leaseId).toBe('lease-1');
      expect(receipt.profiles).toEqual([
        { provider: 'claude', profileId: 'legacy', label: 'ClaudeSUAS', previousPolicy: 'disabled', policy: 'manual-only' },
        { provider: 'codex', profileId: 'legacy', label: 'CodexSUAS', previousPolicy: 'allow-routed', policy: 'manual-only' },
      ]);
      expect(store.policy('claude', 'legacy')).toBe('manual-only');
      expect(store.policy('codex', 'legacy')).toBe('manual-only');
      expect(store.policy('claude', 'other-1111')).toBe('allow-routed');
    });

    it('writes the saved originals to disk before it changes any policy', () => {
      let onDiskAtFirstWrite: string | null = null;
      const original = store.updateProfile.bind(store);
      store.updateProfile = (provider, id, input) => {
        onDiskAtFirstWrite ??= fs.readFileSync(filePath, 'utf8');
        return original(provider, id, input);
      };
      make().reserve('owner-1', { profiles: both });
      expect(onDiskAtFirstWrite).toContain('"originalPolicy": "disabled"');
    });

    it('does not write for a profile that is already manual-only and still restores it to manual-only', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [{ provider: 'opencode', profileId: 'subs-1a2b' }] });
      expect(store.writes).toEqual([]);
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.profiles[0]?.outcome).toBe('already-original');
      expect(store.policy('opencode', 'subs-1a2b')).toBe('manual-only');
    });

    it('rejects a missing profile without changing anything', () => {
      expect(() => make().reserve('owner-1', {
        profiles: [...both, { provider: 'opencode', profileId: 'nope' }],
      })).toThrow(/profile-missing/);
      expect(store.writes).toEqual([]);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('rejects duplicates, an empty list, too many accounts and a bad ttl', () => {
      const service = make();
      expect(() => service.reserve('owner-1', { profiles: [both[0]!, both[0]!] })).toThrow(/only once/);
      expect(() => service.reserve('owner-1', { profiles: [] })).toThrow(/between 1 and 6/);
      expect(() => service.reserve('owner-1', {
        profiles: Array.from({ length: 7 }, (_, i) => ({ provider: 'claude' as const, profileId: `p${i}` })),
      })).toThrow(/between 1 and 6/);
      expect(() => service.reserve('owner-1', { profiles: [both[0]!], ttlMinutes: 0 })).toThrow(/ttlMinutes/);
      expect(() => service.reserve('owner-1', { profiles: [both[0]!], ttlMinutes: 721 })).toThrow(/ttlMinutes/);
      expect(() => service.reserve('owner-1', { profiles: [{ provider: 'gemini' as never, profileId: 'legacy' }] })).toThrow(/Unknown provider/);
      expect(store.writes).toEqual([]);
    });

    it('refuses an account that another lease already holds, even for another session', () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      expect(() => service.reserve('owner-2', { profiles: both })).toThrow(/already reserved/);
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');
    });

    it('rolls back profiles already changed when a later write fails', () => {
      store.failWritesFor = 'codex:legacy';
      expect(() => make().reserve('owner-1', { profiles: both })).toThrow(/put back/);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).leases).toEqual([]);
    });
  });

  describe('release', () => {
    it('restores every saved policy and returns a receipt', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.complete).toBe(true);
      expect(receipt.reason).toBe('released');
      expect(receipt.profiles.map((p) => [p.provider, p.outcome, p.restoredTo])).toEqual([
        ['claude', 'restored', 'disabled'],
        ['codex', 'restored', 'allow-routed'],
      ]);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');
      expect(service.status('owner-1').leases).toEqual([]);
    });

    it('leaves a policy someone changed by hand during the lease and says so', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      store.getProfile('codex', 'legacy')!.automationPolicy = 'disabled';
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.profiles[1]).toMatchObject({ outcome: 'left-changed-by-someone-else', currentPolicy: 'disabled' });
      expect(store.policy('codex', 'legacy')).toBe('disabled');
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(receipt.complete).toBe(true);
    });

    it('reports a profile that was removed during the lease', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [{ provider: 'opencode', profileId: 'subs-1a2b' }, both[0]!] });
      store.profiles = store.profiles.filter((p) => p.provider !== 'opencode');
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.profiles.map((p) => p.outcome)).toEqual(['profile-removed', 'restored']);
      expect(receipt.complete).toBe(true);
    });

    it('keeps the lease when a restore fails, and a later release finishes the job', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      store.failWritesFor = 'claude:legacy';
      const first = await service.release('owner-1', 'lease-1');
      expect(first.complete).toBe(false);
      expect(first.profiles[0]).toMatchObject({ outcome: 'restore-failed', error: 'store refused the write' });
      expect(first.sessions).toEqual([]);
      expect(service.status('owner-1').leases).toHaveLength(1);
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');

      store.failWritesFor = null;
      const second = await service.release('owner-1', 'lease-1');
      expect(second.complete).toBe(true);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(service.status('owner-1').leases).toEqual([]);
    });

    it('refuses a lease that belongs to another session and one that does not exist, with the same message shape', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await expect(service.release('owner-2', 'lease-1')).rejects.toThrow(/No active trial lease "lease-1"/);
      await expect(service.release('owner-1', 'lease-99')).rejects.toThrow(/No active trial lease "lease-99"/);
      expect(store.policy('claude', 'legacy')).toBe('manual-only');
    });

    it('cannot be run twice for one lease', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await service.release('owner-1', 'lease-1');
      await expect(service.release('owner-1', 'lease-1')).rejects.toThrow(/No active trial lease/);
    });

    it('stops the sessions the lease started', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'a' });
      await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'codex', profileId: 'legacy', prompt: 'b' });
      const receipt = await service.release('owner-1', 'lease-1');
      expect(stopped).toEqual(['arm-1-legacy', 'arm-2-legacy']);
      expect(receipt.sessions.every((s) => s.stopped)).toBe(true);
    });

    it('still stops the sessions when the lease file cannot be rewritten after the policies are back', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'a' });
      // A folder where the file should be makes the final rename fail.
      fs.rmSync(filePath);
      fs.mkdirSync(filePath);
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.complete).toBe(true);
      expect(stopped).toEqual(['arm-1-legacy']);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
    });

    it('reports a session that would not stop without losing the restored policies', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'a' });
      const terminate = vi.fn(async () => { throw new Error('stuck'); });
      const failing = new AccountTrialLeaseService({ ...deps(), terminateSession: terminate });
      const receipt = await failing.release('owner-1', 'lease-1');
      expect(receipt.complete).toBe(true);
      expect(receipt.sessions).toEqual([{ instanceId: 'arm-1-legacy', stopped: false, error: 'stuck' }]);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
    });
  });

  describe('start_session', () => {
    it('starts a session only on an account in the caller\'s own live lease', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      const result = await service.startSession('owner-1', {
        leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'go', model: 'm', workingDirectory: '/tmp/x', name: 'arm A',
      });
      expect(result).toEqual({ instanceId: 'arm-1-legacy', leaseId: 'lease-1' });
      expect(service.status('owner-1').leases[0]?.sessionIds).toEqual(['arm-1-legacy']);
    });

    it('refuses an account outside the lease, another owner\'s lease, and an expired lease', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'codex', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/not part of this lease/);
      await expect(service.startSession('owner-2', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/No active trial lease/);
      now += 241 * 60_000;
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/expired/);
      expect(started).toEqual([]);
    });

    it('needs a Token Plan model for a MiMo account, because OpenCode would otherwise ignore the account', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [{ provider: 'opencode', profileId: 'subs-1a2b' }] });
      const base = { leaseId: 'lease-1', provider: 'opencode' as const, profileId: 'subs-1a2b', prompt: 'x' };
      await expect(service.startSession('owner-1', base)).rejects.toThrow(/Token Plan model/);
      await expect(service.startSession('owner-1', { ...base, model: 'gpt-5' })).rejects.toThrow(/Token Plan model/);
      expect(started).toEqual([]);
      await expect(service.startSession('owner-1', { ...base, model: 'xiaomi-token-plan-ams/mimo-v2' }))
        .resolves.toMatchObject({ leaseId: 'lease-1' });
    });

    it('caps the sessions one lease may start', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      for (let i = 0; i < 16; i += 1) {
        await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' });
      }
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/at most 16/);
    });

    it('holds the session cap when many starts run at the same time', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      const attempts = Array.from({ length: 20 }, () => service.startSession(
        'owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' },
      ));
      const results = await Promise.allSettled(attempts);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(16);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
      expect(started).toHaveLength(16);
      expect(service.status('owner-1').leases[0]?.sessionIds).toHaveLength(16);
    });

    it('gives a failed start back to the cap, so a later start can use the slot', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      startError = new Error('not signed in');
      const failed = await Promise.allSettled(Array.from({ length: 16 }, () => service.startSession(
        'owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' },
      )));
      expect(failed.every((r) => r.status === 'rejected')).toBe(true);
      startError = null;
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' }))
        .resolves.toMatchObject({ leaseId: 'lease-1' });
    });

    it('keeps the lease when the session cannot start, so another account can still be tried', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      startError = new Error('The ClaudeSUAS account is not signed in.');
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/not signed in/);
      expect(service.status('owner-1').leases).toHaveLength(1);
      expect(service.status('owner-1').leases[0]?.sessionIds).toEqual([]);
      expect(store.policy('claude', 'legacy')).toBe('manual-only');
      startError = null;
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'codex', profileId: 'legacy', prompt: 'x' }))
        .resolves.toMatchObject({ leaseId: 'lease-1' });
    });

    it('starts no further sessions on a lease whose release has begun but could not finish', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      store.failWritesFor = 'claude:legacy';
      await service.release('owner-1', 'lease-1');
      await expect(service.startSession('owner-1', { leaseId: 'lease-1', provider: 'codex', profileId: 'legacy', prompt: 'x' }))
        .rejects.toThrow(/being released/);
      expect(started).toEqual([]);
    });

    it('stops a session that finished starting after its lease had already ended', async () => {
      let finishStart: (() => void) | undefined;
      const slow = new AccountTrialLeaseService({
        ...deps(),
        startSession: () => new Promise((resolve) => { finishStart = () => resolve({ instanceId: 'late-arm' }); }),
      });
      slow.reserve('owner-1', { profiles: [both[0]!] });
      const pending = slow.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' });
      const rejection = expect(pending).rejects.toThrow(/lease ended while the session was starting/);
      await slow.release('owner-1', 'lease-1');
      finishStart?.();
      await rejection;
      expect(stopped).toEqual(['late-arm']);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
    });
  });

  describe('status', () => {
    it('shows only the caller\'s leases, what each would restore, and counts the rest', () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!] });
      service.reserve('owner-2', { profiles: [both[1]!] });
      const status = service.status('owner-1');
      expect(status.otherActiveLeases).toBe(1);
      expect(status.leases).toEqual([{
        leaseId: 'lease-1',
        expiresAt: 1_000_000 + 240 * 60_000,
        profiles: [{ provider: 'claude', profileId: 'legacy', label: 'ClaudeSUAS', restoreTo: 'disabled', currentPolicy: 'manual-only' }],
        sessionIds: [],
      }]);
    });
  });

  describe('sweep and recovery', () => {
    it('ends a lease whose owning session is gone and stops its sessions', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      await service.startSession('owner-1', { leaseId: 'lease-1', provider: 'claude', profileId: 'legacy', prompt: 'x' });
      live.delete('owner-1');
      expect(await service.sweep()).toBe(1);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');
      expect(stopped).toEqual(['arm-1-legacy']);
      expect(service.status('owner-1').leases).toEqual([]);
    });

    it('ends an expired lease even while its owner is alive, and leaves a current one alone', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: [both[0]!], ttlMinutes: 5 });
      service.reserve('owner-2', { profiles: [both[1]!], ttlMinutes: 60 });
      now += 6 * 60_000;
      expect(await service.sweep()).toBe(1);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(store.policy('codex', 'legacy')).toBe('manual-only');
    });

    it('keeps a lease that cannot be restored and tries again on the next sweep', async () => {
      const service = make();
      service.reserve('owner-1', { profiles: both });
      live.delete('owner-1');
      store.failWritesFor = 'claude:legacy';
      expect(await service.sweep()).toBe(1);
      expect(service.status('owner-1').leases).toHaveLength(1);
      store.failWritesFor = null;
      await service.sweep();
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(service.status('owner-1').leases).toEqual([]);
    });

    it('puts everything back at startup from the file a crashed run left behind', async () => {
      make().reserve('owner-1', { profiles: both });
      expect(store.policy('claude', 'legacy')).toBe('manual-only');

      const restarted = make();
      expect(await restarted.recover()).toBe(1);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
      expect(store.policy('codex', 'legacy')).toBe('allow-routed');
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).leases).toEqual([]);
    });

    it('recovers a crash that happened after the file was written but before any policy changed', async () => {
      store.failWritesFor = 'claude:legacy';
      const crashing = make();
      expect(() => crashing.reserve('owner-1', { profiles: both })).toThrow();
      // Simulate the process dying instead of rolling back: put the lease back on disk by hand.
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        leases: [{
          id: 'lease-9', ownerInstanceId: 'owner-1', createdAt: 1, expiresAt: 2,
          profiles: [{ provider: 'claude', profileId: 'legacy', label: 'ClaudeSUAS', originalPolicy: 'disabled' }], sessionIds: [],
        }],
      }));
      store.failWritesFor = null;
      const receiptCount = await make().recover();
      expect(receiptCount).toBe(1);
      expect(store.policy('claude', 'legacy')).toBe('disabled');
    });

    it.each([
      ['a null profile entry', { profiles: [null] }],
      ['an unknown provider', { profiles: [{ provider: 'gemini', profileId: 'legacy', label: 'x', originalPolicy: 'disabled' }] }],
      ['a policy that is not one of the three', { profiles: [{ provider: 'claude', profileId: 'legacy', label: 'x', originalPolicy: 'wide-open' }] }],
      ['a missing owner', { ownerInstanceId: undefined }],
    ])('sets aside a file with %s instead of writing from it', async (_name, patch) => {
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        leases: [{
          id: 'lease-9', ownerInstanceId: 'owner-1', createdAt: 1, expiresAt: 2, sessionIds: [],
          profiles: [{ provider: 'claude', profileId: 'legacy', label: 'ClaudeSUAS', originalPolicy: 'disabled' }],
          ...patch,
        }],
      }));
      const service = make();
      expect(await service.recover()).toBe(0);
      expect(store.writes).toEqual([]);
      expect(fs.readdirSync(dir).some((name) => name.startsWith('leases.json.corrupt-'))).toBe(true);
    });

    it('sets aside an unreadable file instead of guessing, and starts empty', () => {
      fs.writeFileSync(filePath, '{not json');
      const service = make();
      expect(service.status('owner-1')).toEqual({ leases: [], otherActiveLeases: 0 });
      expect(fs.readdirSync(dir).some((name) => name.startsWith('leases.json.corrupt-'))).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });
  });

  describe('with the real profile store', () => {
    it('reserves and restores legacy Claude and Codex profiles through the same validation Settings uses', async () => {
      let profiles = [
        profile('claude', 'legacy', 'ClaudeSUAS', 'disabled'),
        profile('codex', 'legacy', 'CodexSUAS', 'allow-routed'),
        { ...profile('claude', 'adapt-1111', 'Adapt', 'allow-routed'), priority: 1 },
      ];
      const real = new ProviderAccountStore({
        read: () => ({ profiles, pools: {} }),
        write: (update) => { if (update.profiles) profiles = update.profiles; },
      });
      const service = new AccountTrialLeaseService({ ...deps(), store: real });
      service.reserve('owner-1', { profiles: both });
      expect(profiles.map((p) => p.automationPolicy)).toEqual(['manual-only', 'manual-only', 'allow-routed']);
      const receipt = await service.release('owner-1', 'lease-1');
      expect(receipt.complete).toBe(true);
      expect(profiles.map((p) => p.automationPolicy)).toEqual(['disabled', 'allow-routed', 'allow-routed']);
      expect(profiles.map((p) => p.enabled)).toEqual([true, true, true]);
    });
  });
});
