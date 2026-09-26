import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { MobileGatewayServer, type GatewayInstanceSource } from './mobile-gateway-server';
import { MobileDeviceRegistry } from './mobile-device-registry';
import type { ProviderQuotaSnapshot, ProviderQuotaState, ProviderQuotaWindow } from '../../shared/types/provider-quota.types';
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
  beforeEach(async () => {
    quota = new QuotaSource(); pushes = []; sockets = [];
    const source = Object.assign(new EventEmitter(), { getAllInstances: () => [], getInstance: () => undefined, getOrchestrationHandler: () => new EventEmitter() });
    const registry = new MobileDeviceRegistry({ load: () => undefined, save: () => undefined });
    const paired = registry.pair({ pairingToken: registry.issuePairing().pairingToken });
    if (paired.status !== 'paired') throw new Error('Pairing failed');
    token = paired.device.token;
    registry.setApnsToken(paired.device.deviceId, 'quota-push-placeholder');
    server = new MobileGatewayServer();
    server.initialize({ instanceManager: source as unknown as GatewayInstanceSource, registry,
      quotaSource: quota,
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

  it('projects multiple windows and omits account-pool details from the authenticated response', async () => {
    quota.update(snapshot({ accountProfileId: 'private-profile-placeholder', plan: 'private-plan-placeholder',
      windows: [window(60), window(20, { id: 'codex.weekly', label: 'Weekly' })] }));
    quota.state.accountSnapshots = [snapshot({ accountProfileId: 'pooled-profile-placeholder' })];
    expect((await fetch(`${base}/api/quota`)).status).toBe(401);
    const body = await read();
    expect(body.providers.find((p: { provider: string }) => p.provider === 'codex')).toMatchObject({
      freshness: 'fresh', exhausted: false,
      windows: [{ percentUsed: 60, exhausted: false }, { percentUsed: 20, exhausted: false }],
    });
    expect(JSON.stringify(body)).not.toMatch(/private-|pooled-|accountProfile|accountSnapshots|usageAccess/);
  });

  it.each([
    ['zero limit', { windows: [window(100, { limit: 0 })] }],
    ['unknown limit', { windows: [window(100, { limit: Number.NaN })] }],
    ['missing reset', { windows: [window(100, { resetsAt: null })] }],
    ['expired reset', { windows: [window(100, { resetsAt: 1 })] }],
    ['stale', { takenAt: 1 }],
    ['reauth', { needsReauth: true }],
    ['not installed', { cliNotInstalled: true }],
    ['not applicable', { notApplicable: true }],
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
