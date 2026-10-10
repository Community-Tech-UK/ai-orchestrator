import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'child_process';
import type { AccountBindingStatus, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));
vi.mock('../../core/system/provider-limit-ledger', () => ({ getProviderLimitLedgerPort: vi.fn() }));
vi.mock('./account-quota-evidence', async (importOriginal) => ({
  ...await importOriginal<typeof import('./account-quota-evidence')>(),
  readAccountQuotaEvidence: vi.fn(() => null),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});

import { ProviderAccountStore } from './provider-account-store';
import { quotaEvidenceFromSnapshot } from './account-quota-evidence';
import { ProviderAccountRoutingService, type ProviderAccountRoutingDeps } from './provider-account-routing-service';
import { ProviderAccountBindingService } from './provider-account-binding-service';
import type { AccountQuotaEvidence } from './provider-account-selector';

function profile(id: string, priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1, ...overrides,
  };
}

let profiles: ProviderAccountProfile[];
let bindingStates: Record<string, AccountBindingStatus['state']>;
let parked: string[];
let quota: Record<string, AccountQuotaEvidence>;
const checkBinding = vi.fn(async (entry: ProviderAccountProfile) => ({
  provider: entry.provider, profileId: entry.id, nodeId: 'local', state: bindingStates[entry.id] ?? 'authenticated', checkedAt: 1,
}) as AccountBindingStatus);

function service(overrides: Partial<ProviderAccountRoutingDeps> = {}): ProviderAccountRoutingService {
  const pools = defaultProviderAccountPools();
  const store = new ProviderAccountStore({
    read: () => ({ profiles, pools }),
    write: () => undefined,
  });
  return new ProviderAccountRoutingService({
    store,
    bindingService: { checkBinding, invalidate: vi.fn() } as unknown as ProviderAccountBindingService,
    getParkedProfileIds: () => parked,
    getSoonestResumeAt: (_provider, _model, ids) => (ids[0] === 'max-b' ? 1000 : 5000),
    getQuotaEvidence: (_provider, id) => quota[id] ?? null,
    ...overrides,
  });
}

beforeEach(() => {
  vi.mocked(execFile).mockReset();
  profiles = [profile('legacy', 0), profile('max-b', 1)];
  bindingStates = {};
  parked = [];
  quota = {};
  checkBinding.mockClear();
});

describe('ProviderAccountRoutingService', () => {
  it.each(['unauthenticated', 'unavailable'] as const)('fresh admission refuses current %s despite an authenticated cache', async (state) => {
    const target = profile('max-b', 1, { provider: 'opencode', region: 'ams' });
    let output: string | null = '┌  Credentials\n●  aio-mimo-max-b api\n└  1 credentials\n';
    let reads = 0;
    const bindings = new ProviderAccountBindingService({ readOpenCodeAuthList: async () => { reads++; return output; } });
    const routing = new ProviderAccountRoutingService({ bindingService: bindings });
    expect(await routing.admit(target, 'explicit')).toMatchObject({ ok: true });
    output = state === 'unauthenticated' ? '┌  Credentials\n└  0 credentials\n' : null;
    expect(await routing.admit(target, 'explicit')).toMatchObject({ ok: true });
    expect(reads).toBe(1);
    expect(await routing.admit(target, 'explicit', 'local', { force: true })).toMatchObject({
      ok: false, profileId: 'max-b', code: state === 'unauthenticated' ? 'profile-unauthenticated' : 'profile-not-bound-on-node',
    });
    expect(reads).toBe(2);
    expect(routing.getLastUsedAt('opencode').size).toBe(0);
  });

  it('fresh admission bypasses prior in-flight sign-in evidence', async () => {
    const target = profile('max-b', 1, { provider: 'opencode', region: 'ams' });
    let release!: (output: string) => void;
    let reads = 0;
    const bindings = new ProviderAccountBindingService({ readOpenCodeAuthList: () => {
      reads++;
      return reads === 1 ? new Promise<string>((resolve) => { release = resolve; })
        : Promise.resolve('┌  Credentials\n└  0 credentials\n');
    } });
    const routing = new ProviderAccountRoutingService({ bindingService: bindings });
    const previous = bindings.checkBinding(target);
    try {
      expect(await routing.admit(target, 'explicit', 'local', { force: true }))
        .toMatchObject({ ok: false, code: 'profile-unauthenticated' });
      expect(reads).toBe(2);
    } finally {
      release('┌  Credentials\n●  aio-mimo-max-b api\n└  1 credentials\n');
      await previous;
    }
  });

  it.each([{ code: 7 }, { killed: true, signal: 'SIGTERM' as const }])('fresh admission rejects failed auth-list output %j', async (properties) => {
    const target = profile('max-b', 1, { provider: 'opencode', region: 'ams' });
    vi.mocked(execFile).mockImplementation((file, args, options, callback) => {
      expect(file).toBe('opencode');
      expect(args).toEqual(['auth', 'list']);
      expect(options).toMatchObject({ timeout: 8_000, maxBuffer: 256 * 1024 });
      if (!callback) throw new Error('Missing auth-list callback');
      queueMicrotask(() => callback(Object.assign(new Error('error-placeholder'), properties),
        '┌  Credentials\n●  aio-mimo-max-b api\n└  1 credentials\n', 'stderr-placeholder'));
      return {} as ChildProcess;
    });
    const routing = new ProviderAccountRoutingService({ bindingService: new ProviderAccountBindingService() });
    expect(await routing.admit(target, 'explicit', 'local', { force: true }))
      .toMatchObject({ ok: false, code: 'profile-not-bound-on-node', detail: expect.stringContaining('auth-list-unreadable') });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith('opencode', ['auth', 'list'],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
  });

  it('returns the legacy route with no binding check while only the legacy profile exists', async () => {
    profiles = [profile('legacy', 0)];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toEqual({ ok: true, route: expect.objectContaining({ profileId: 'legacy', source: 'legacy' }) });
    expect(checkBinding).not.toHaveBeenCalled();
  });

  it('keeps a persisted profile even when a higher-priority one is free', async () => {
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', persistedProfileId: 'max-b' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'persisted' } });
  });

  it('refuses a persisted profile that was removed rather than moving the thread', async () => {
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', persistedProfileId: 'gone' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-missing' });
  });

  it('admission never substitutes: an unauthenticated explicit profile fails', async () => {
    bindingStates = { 'max-b': 'unauthenticated' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', explicitProfileId: 'max-b' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-unauthenticated', profileId: 'max-b' });
  });

  it('refuses a disabled or automation-disallowed explicit profile', async () => {
    profiles = [profile('legacy', 0), profile('max-b', 1, { enabled: false }), profile('max-c', 2, { automationPolicy: 'manual-only' })];
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', explicitProfileId: 'max-b' }))
      .resolves.toMatchObject({ code: 'profile-disabled' });
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'automation', explicitProfileId: 'max-c' }))
      .resolves.toMatchObject({ code: 'automation-disallowed' });
  });

  it('defaults past a parked profile to the next in priority', async () => {
    parked = ['legacy'];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b', source: 'default', profileLabel: 'Label max-b' } });
  });

  it.each([[20, undefined], [100, 20]] as const)('does not lift a MiMo rate-limit park on calendar counters alone (%s, %s)', async (used, compensation) => {
    profiles = [profile('legacy', 0, { provider: 'opencode', region: 'ams' }), profile('max-b', 1, { provider: 'opencode', region: 'ams' })];
    parked = ['legacy'];
    const evidence = quotaEvidenceFromSnapshot({ provider: 'opencode', source: 'admin-api', ok: true, takenAt: 2000,
      windows: [
        { id: 'opencode.plan', label: 'Plan', kind: 'calendar-period', unit: 'tokens', used, limit: 100, remaining: 100 - used, resetsAt: null },
        ...(compensation === undefined ? [] : [{ id: 'opencode.compensation', label: 'Compensation', kind: 'calendar-period' as const,
          unit: 'tokens' as const, used: compensation, limit: 100, remaining: 100 - compensation, resetsAt: null }]),
      ] });
    quota = { legacy: evidence! };
    const preview = await service({ getParkedSince: () => new Map([['legacy', 1000]]) })
      .preview({ provider: 'opencode', origin: 'interactive' });
    expect(preview).toMatchObject({ outcome: { ok: true, route: { profileId: 'max-b' } },
      considered: [{ profileId: 'legacy', vetoReason: 'parked' }] });
  });

  it('preserves a fresh explicit usage-access verdict for MiMo despite spent counters', async () => {
    profiles = [profile('legacy', 0, { provider: 'opencode', region: 'ams' }), profile('max-b', 1, { provider: 'opencode', region: 'ams' })];
    parked = ['legacy'];
    quota = { legacy: quotaEvidenceFromSnapshot({ provider: 'opencode', source: 'admin-api', ok: true, takenAt: 2000,
      windows: [{ id: 'opencode.plan', label: 'Plan', kind: 'calendar-period', unit: 'tokens', used: 100, limit: 100, remaining: 0, resetsAt: null }],
      usageAccess: { ordinaryUsageAllowed: true, creditsAvailable: null },
    })! };
    const outcome = await service({ getParkedSince: () => new Map([['legacy', 1000]]) })
      .resolveRouteForSpawn({ provider: 'opencode', origin: 'interactive', newSession: false });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'legacy' } });
  });

  it('routes to the soonest reset when every signed-in profile is parked', async () => {
    parked = ['legacy', 'max-b'];
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b' } });
  });

  it('steers a new session to plan usage first, and onto purchased credits only for attended work', async () => {
    quota = { legacy: { weeklyPct: 100, usable: true, creditsOnly: true } };
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' }))
      .resolves.toMatchObject({ ok: true, route: { profileId: 'max-b' } });
    quota['max-b'] = { weeklyPct: 100, usable: false };
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' }))
      .resolves.toMatchObject({ ok: true, route: { profileId: 'legacy' } });
    // Unattended work is not put on credits; it lands on the soonest reset and parks there.
    await expect(service().resolveRouteForSpawn({ provider: 'claude', origin: 'automation' }))
      .resolves.toMatchObject({ ok: true, route: { profileId: 'max-b' } });
  });

  it('still routes a new session when every account reports its usage spent, rather than refusing it', async () => {
    quota = { legacy: { weeklyPct: 100, usable: false }, 'max-b': { weeklyPct: 100, usable: false } };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'max-b' } });
  });

  it('fails with a typed reason when no profile is signed in', async () => {
    bindingStates = { legacy: 'unauthenticated', 'max-b': 'identity-mismatch' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive' });
    expect(outcome).toMatchObject({ ok: false, code: 'profile-unauthenticated' });
  });

  it('skips binding checks for remote placement', async () => {
    bindingStates = { legacy: 'unauthenticated' };
    const outcome = await service().resolveRouteForSpawn({ provider: 'claude', origin: 'interactive', executionNodeId: 'node-1' });
    expect(outcome).toMatchObject({ ok: true, route: { profileId: 'legacy', executionNodeId: 'node-1' } });
    expect(checkBinding).not.toHaveBeenCalled();
  });
});
