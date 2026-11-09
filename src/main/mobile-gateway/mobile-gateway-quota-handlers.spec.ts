import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MobileGatewayServer, type GatewayInstanceSource } from './mobile-gateway-server';
import { MobileDeviceRegistry } from './mobile-device-registry';
import type { ProviderQuotaSnapshot, ProviderQuotaState, ProviderQuotaWindow } from '../../shared/types/provider-quota.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { claudeUsageAccess, parseUsagePayload } from '../core/system/provider-quota/claude-usage-endpoint-probe';

const now = () => Date.now();
function window(used = 100, overrides: Partial<ProviderQuotaWindow> = {}): ProviderQuotaWindow {
  return { id: 'codex.5h', label: '5 hours', kind: 'rolling-window', unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt: now() + 3_600_000, ...overrides };
}
// `it.each(... as const)` produces readonly window tuples; accept them and copy
// into the mutable `ProviderQuotaWindow[]` that ProviderQuotaSnapshot declares.
type SnapshotOverrides = Omit<Partial<ProviderQuotaSnapshot>, 'windows'> & {
  windows?: readonly ProviderQuotaWindow[];
};
function snapshot(overrides: SnapshotOverrides = {}): ProviderQuotaSnapshot {
  const { windows, ...rest } = overrides;
  return { provider: 'codex', takenAt: now(), source: 'admin-api', ok: true,
    windows: windows ? [...windows] : [window()], usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: false }, ...rest };
}
class QuotaSource extends EventEmitter {
  state: ProviderQuotaState = { snapshots: { claude: null, codex: null, gemini: null, antigravity: null, copilot: null, cursor: null, grok: null, opencode: null } };
  getAll() { return this.state; }
  update(value: ProviderQuotaSnapshot) {
    this.state.snapshots[value.provider] = value;
    this.emit('quota-updated', value);
  }
}

describe('mobile quota authenticated runtime projection and lifecycle', () => {
  let server: MobileGatewayServer;
  let quota: QuotaSource;
  let base: string;
  let token: string;
  let pushes: unknown[];
  let sockets: WebSocket[];
  let profiles: ProviderAccountProfile[];
  beforeEach(async () => {
    quota = new QuotaSource(); pushes = []; sockets = []; profiles = [];
    const source = Object.assign(new EventEmitter(), { getAllInstances: () => [], getInstance: () => undefined, getOrchestrationHandler: () => new EventEmitter() });
    const registry = new MobileDeviceRegistry({
      load: () => undefined, save: () => undefined, loadProfiles: () => undefined, saveProfiles: () => undefined,
    });
    const paired = registry.pair({ pairingToken: registry.issuePairing().pairingToken });
    if (paired.status !== 'paired') throw new Error('Pairing failed');
    token = paired.device.token;
    registry.setApnsToken(paired.device.deviceId, 'quota-push-placeholder');
    server = new MobileGatewayServer();
    server.initialize({ instanceManager: source as unknown as GatewayInstanceSource, registry,
      quotaSource: quota,
      accountProfiles: () => profiles,
      pauseCoordinator: Object.assign(new EventEmitter(), { toPayload: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }), addReason: vi.fn(), removeReason: vi.fn() }),
      loopCoordinator: Object.assign(new EventEmitter(), { getActiveLoops: () => [] }),
      apnsSender: { isConfigured: () => true, send: async (_tokens: string[], alert: unknown) => { pushes.push(alert); return []; } } as never,
    });
    const status = await server.start({ port: 0, bindInterface: 'all' });
    base = `http://127.0.0.1:${status.port}`;
  });
  afterEach(async () => { for (const socket of sockets) socket.terminate(); await server.stop(); });
  async function read() {
    const response = await fetch(`${base}/api/quota`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    return response.json();
  }

  function profile(id: string, label: string, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
    return {
      id, provider: 'codex', label, expectedIdentity: `${id}@example.invalid`, expectedAccountKey: `${id}-key`,
      planLabel: null, priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
      createdAt: 1, updatedAt: 1, ...overrides,
    };
  }

  it('projects multiple windows for the existing sign-in', async () => {
    quota.update(snapshot({ windows: [window(60), window(20, { id: 'codex.weekly', label: 'Weekly' })] }));
    expect((await fetch(`${base}/api/quota`)).status).toBe(401);
    const body = await read();
    expect(body.providers.find((p: { provider: string }) => p.provider === 'codex')).toMatchObject({
      freshness: 'fresh', exhausted: false,
      windows: [{ percentUsed: 60, exhausted: false }, { percentUsed: 20, exhausted: false }],
      accounts: [{ id: 'legacy', label: null, summaryWindowId: 'codex.weekly', windows: [{ percentUsed: 60 }, { percentUsed: 20 }] }],
    });
  });

  it('lists every account under its own name, existing sign-in first, without sign-in identities', async () => {
    profiles = [
      profile('legacy', 'Main', { isLegacy: true }),
      profile('second', 'Max B', { priority: 2, enabled: false }),
      profile('first', 'Max A', { priority: 1 }),
    ];
    quota.update(snapshot({ plan: 'pro', windows: [window(40)] }));
    quota.state.accountSnapshots = [
      snapshot({ accountProfileId: 'second', windows: [window(90)] }),
      snapshot({ accountProfileId: 'first', ok: false, needsReauth: true, error: 'probe-detail-placeholder', windows: [window(10)] }),
      snapshot({ accountProfileId: 'removed', windows: [window(5)] }),
    ];
    const body = await read();
    const codex = body.providers.find((p: { provider: string }) => p.provider === 'codex');
    expect(codex.accounts).toEqual([
      expect.objectContaining({ id: 'legacy', label: 'Main', plan: 'pro', windows: [expect.objectContaining({ percentUsed: 40 })] }),
      expect.objectContaining({ id: 'first', label: 'Max A', needsReauth: true, freshness: 'unavailable' }),
      expect.objectContaining({ id: 'second', label: 'Max B (disabled)', disabled: true }),
    ]);
    expect(codex.accounts[0]).not.toHaveProperty('disabled');
    expect(JSON.stringify(body)).not.toMatch(/example\.invalid|-key|probe-detail|removed|usageAccess|accountProfileId/);
  });

  it.each([
    ['not installed', { cliNotInstalled: true }],
    ['not applicable', { notApplicable: true }],
  ] as const)('leaves out a provider whose quota is %s, as the desktop chip does', async (_label, overrides) => {
    quota.update(snapshot(overrides));
    const body = await read();
    expect(body.providers.map((p: { provider: string }) => p.provider)).not.toContain('codex');
    expect(pushes).toHaveLength(0);
  });

  it('leaves out providers that have never been measured', async () => {
    quota.update(snapshot());
    const body = await read();
    expect(body.providers.map((p: { provider: string }) => p.provider)).toEqual(['codex']);
  });

  it.each([
    ['zero limit', { windows: [window(100, { limit: 0 })] }],
    ['unknown limit', { windows: [window(100, { limit: Number.NaN })] }],
    ['missing reset', { windows: [window(100, { resetsAt: null })] }],
    ['expired reset', { windows: [window(100, { resetsAt: 1 })] }],
    ['stale', { takenAt: 1 }],
    ['reauth', { needsReauth: true }],
    ['failed', { ok: false }],
    ['credits', { usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true } }],
    ['unknown credits', { usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: null } }],
    ['allowed', { usageAccess: { ordinaryUsageAllowed: true, creditsAvailable: false } }],
    ['ambiguous access', { usageAccess: undefined }],
    ['stale denial', { usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: false, observedAt: 1 } }],
  ] as const)('never calls %s exhausted or pushes it', async (_label, overrides) => {
    quota.update(snapshot(overrides));
    const body = await read();
    const provider = body.providers.find((p: { provider: string }) => p.provider === 'codex');
    expect(provider.exhausted).toBe(false);
    expect(provider.windows.every((w: { exhausted: boolean }) => !w.exhausted)).toBe(true);
    expect(pushes).toHaveLength(0);
  });

  it('keeps a full Claude plan with canonical unknown credits informational without a push', async () => {
    const windows = parseUsagePayload({ five_hour: { utilization: 100, resets_at: new Date(now() + 3_600_000).toISOString() } });
    quota.update(snapshot({ provider: 'claude', windows, usageAccess: claudeUsageAccess(windows)! }));
    const body = await read();
    expect(body.providers.find((provider: { provider: string }) => provider.provider === 'claude')).toMatchObject({
      exhausted: false, windows: [{ percentUsed: 100, exhausted: false }],
    });
    expect(pushes).toHaveLength(0);
  });

  it('does not resend for sliding reset estimates or timestamp corrections while still exhausted', () => {
    const resetsAt = now() + 3_600_000;
    quota.update(snapshot({ windows: [window(100, { resetsAt })] }));
    for (const correction of [60_000, -60_000, 120_000, 0]) {
      quota.update(snapshot({ windows: [window(100, { resetsAt: resetsAt + correction })] }));
      expect(pushes).toHaveLength(1);
    }
  });

  it('only rearms on fresh known reset recovery and keeps provider/window edges independent', () => {
    const resetsAt = now() + 3_600_000;
    const later = resetsAt + 3_600_000;
    quota.update(snapshot({ windows: [window(100, { resetsAt })] }));
    quota.update(snapshot({ windows: [window(0, { resetsAt: later })], takenAt: 1 }));
    quota.update(snapshot({ windows: [window(100, { resetsAt: later })] }));
    expect(pushes).toHaveLength(1);
    quota.update(snapshot({ windows: [window(100, { resetsAt: later })], usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: null } }));
    quota.update(snapshot({ windows: [window(100, { resetsAt: later })] }));
    expect(pushes).toHaveLength(1);
    quota.update(snapshot({ windows: [window(0, { resetsAt: later })] }));
    quota.update(snapshot({ windows: [window(100, { resetsAt: later })] }));
    expect(pushes).toHaveLength(2);
    quota.update(snapshot({ windows: [window(100, { resetsAt: later }), window(100, { id: 'weekly', resetsAt: later })] }));
    expect(pushes).toHaveLength(3);
    quota.update(snapshot({ provider: 'claude', windows: [window(100, { id: 'weekly', resetsAt: later })] }));
    expect(pushes).toHaveLength(4);
    quota.update(snapshot({ windows: [window(100, { resetsAt: later }), window(100, { id: 'weekly', resetsAt: later })] }));
    expect(pushes).toHaveLength(4);
  });

  it('only pushes once every usable account for the provider has run out', async () => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('spare', 'Spare', { priority: 1 }), profile('old', 'Old', { priority: 2, enabled: false })];
    quota.state.accountSnapshots = [
      snapshot({ accountProfileId: 'spare', windows: [window(20)] }),
      snapshot({ accountProfileId: 'old', windows: [window(100)] }),
    ];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(0);

    quota.state.accountSnapshots = [
      snapshot({ accountProfileId: 'spare', windows: [window(100)] }),
      snapshot({ accountProfileId: 'old', windows: [window(100)] }),
    ];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(1);
    quota.update(snapshot({ windows: [window(100, { label: '5 hours (still out)' })] }));
    expect(pushes).toHaveLength(1);
  });

  it('ignores a turned-off account with room left', async () => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('old', 'Old', { priority: 1, enabled: false })];
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'old', windows: [window(10)] })];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(1);
  });

  it('does not let a signed-out account hold back the push', async () => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('spare', 'Spare', { priority: 1 })];
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', ok: false, needsReauth: true, windows: [window(10)] })];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(1);
  });

  it('still pushes when the account that ran out first is no longer freshly measured', async () => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('spare', 'Spare', { priority: 1 })];
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', windows: [window(100)] })];
    quota.update(snapshot({ windows: [window(20)] }));
    expect(pushes).toHaveLength(0);
    // Eight minutes later the spare's probe is stale (probed every 15 minutes) when Main runs out.
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', takenAt: now() - 8 * 60_000, windows: [window(100)] })];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(1);
  });

  it('does not push again when a turned-off account runs out', async () => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('old', 'Old', { priority: 1, enabled: false })];
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'old', windows: [window(10)] })];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(1);
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'old', windows: [window(100)] })];
    quota.update(snapshot({ windows: [window(100)], takenAt: now() - 1 }));
    expect(pushes).toHaveLength(1);
  });

  it('counts an account as out while it is still exhausted after its first reset estimate passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('spare', 'Spare', { priority: 1 })];
      const firstReset = now() + 60_000;
      quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', windows: [window(100, { resetsAt: firstReset })] })];
      quota.update(snapshot({ windows: [window(20)] }));
      vi.setSystemTime(firstReset + 60_000);
      // The spare's reset estimate slid later; it is still out when Main runs out.
      quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', windows: [window(100)] })];
      quota.update(snapshot({ windows: [window(100)] }));
      expect(pushes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['its limit was raised', { windows: [window(30)] }],
    ['credits were topped up', { usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true } }],
  ] as const)('trusts a fresh reading showing room after a spare ran out (%s)', async (_label, recovered) => {
    profiles = [profile('legacy', 'Main', { isLegacy: true }), profile('spare', 'Spare', { priority: 1 })];
    const resetsAt = now() + 3_600_000;
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'spare', windows: [window(100, { resetsAt })] })];
    quota.update(snapshot({ windows: [window(20)] }));
    const spare = snapshot({ accountProfileId: 'spare', windows: [window(100, { resetsAt })], ...recovered });
    quota.state.accountSnapshots = [{ ...spare, windows: spare.windows.map(item => ({ ...item, resetsAt })) }];
    quota.update(snapshot({ windows: [window(100)] }));
    expect(pushes).toHaveLength(0);
  });

  it('broadcasts typed state and pushes at most once per provider/window until reset, then tears down', async () => {
    const frames: Array<{ type: string; data: unknown }> = [];
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws?token=${token}`);
    sockets.push(ws);
    ws.on('message', raw => frames.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const first = snapshot();
    quota.update(first); quota.update(first);
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'quota-state')).toHaveLength(1));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ title: 'Usage limit reached', body: 'Open Harness to check usage and reset times.', data: { kind: 'quota' } });
    expect(JSON.stringify(pushes)).not.toMatch(/codex|5h|account|profile|window/i);
    quota.update(snapshot({ windows: [window(30, { resetsAt: first.windows[0].resetsAt })] }));
    quota.update(snapshot({ windows: [window(100, { resetsAt: first.windows[0].resetsAt })] }));
    expect(pushes).toHaveLength(1);
    quota.update(snapshot({ windows: [window(0, { resetsAt: first.windows[0].resetsAt! + 3_600_000 })] }));
    quota.update(snapshot({ windows: [window(100, { resetsAt: first.windows[0].resetsAt! + 3_600_000 })] }));
    expect(pushes).toHaveLength(2);
    await server.stop();
    expect(quota.listenerCount('quota-updated')).toBe(0);
    quota.update(snapshot());
    expect(pushes).toHaveLength(2);
  });
});
