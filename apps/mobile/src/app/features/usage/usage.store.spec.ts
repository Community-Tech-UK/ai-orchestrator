import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileQuotaStateDto } from '../../core/models';
import { UsageStore } from './usage.store';

export function quotaState(exhausted = true): MobileQuotaStateDto {
  const now = Date.now();
  return { serverTime: now, providers: [{ provider: 'codex', freshness: 'fresh', updatedAt: now, validUntil: now + 300_000, exhausted,
    windows: [{ id: 'codex.5h', label: '5 hours', percentUsed: exhausted ? 100 : 30, resetsAt: now + 3_600_000, exhausted }] }] };
}
function setup() {
  const activeHost = signal({ id: 'a', name: 'Host A' });
  const gateway = { online: signal(true), dataHostId: signal('a'), quotaEvent: signal<{ hostId: string; data: MobileQuotaStateDto } | null>(null), quota: vi.fn().mockResolvedValue(quotaState()) };
  TestBed.configureTestingModule({ providers: [{ provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway }] });
  return { store: TestBed.inject(UsageStore), activeHost, gateway };
}
afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
describe('host-scoped UsageStore', () => {
  it('loads authoritative usage and clears it synchronously when the host changes', async () => {
    const { store, activeHost, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.isExhausted('codex')).toBe(true));
    expect(store.isExhausted('claude')).toBe(false);
    activeHost.set({ id: 'b', name: 'Host B' });
    expect(store.isExhausted('codex')).toBe(false);
    gateway.quota.mockResolvedValue(quotaState(false)); gateway.dataHostId.set('b'); TestBed.tick();
    await vi.waitFor(() => expect(store.providers()[0]?.windows[0].percentUsed).toBe(30));
  });
  it('ignores a departed host response and lets newer events win over pending HTTP', async () => {
    const { store, gateway, activeHost } = setup();
    let release!: (state: MobileQuotaStateDto) => void;
    gateway.quota.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); TestBed.tick();
    activeHost.set({ id: 'b', name: 'Host B' }); gateway.dataHostId.set('b');
    gateway.quota.mockResolvedValue(quotaState(false)); TestBed.tick();
    await vi.waitFor(() => expect(store.providers()[0]?.windows[0].percentUsed).toBe(30));
    release(quotaState()); await Promise.resolve();
    expect(store.isExhausted('codex')).toBe(false);
    gateway.quota.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.refresh();
    gateway.quotaEvent.set({ hostId: 'b', data: quotaState(true) }); TestBed.tick();
    release(quotaState(false)); await pending;
    expect(store.isExhausted('codex')).toBe(true);
  });
  it('removes warnings offline and ages evidence even without a new gateway frame', async () => {
    vi.useFakeTimers(); const { store, gateway } = setup(); TestBed.tick(); await Promise.resolve(); await Promise.resolve();
    expect(store.isExhausted('codex')).toBe(true);
    gateway.online.set(false); expect(store.isExhausted('codex')).toBe(false);
    gateway.online.set(true);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(store.isExhausted('codex')).toBe(false);
    expect(store.providers()[0]?.freshness).toBe('stale');
  });
  it('refreshes on reconnect without replaying an old event over the newer response', async () => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.isExhausted('codex')).toBe(true));
    gateway.quotaEvent.set({ hostId: 'a', data: quotaState(true) }); TestBed.tick();
    gateway.online.set(false); TestBed.tick();
    gateway.quota.mockResolvedValue(quotaState(false));
    gateway.online.set(true); TestBed.tick();
    await vi.waitFor(() => expect(store.providers()[0]?.windows[0].percentUsed).toBe(30));
  });
  it('lists every account and only reports a provider out of usage when every usable account is', async () => {
    const { store, gateway } = setup();
    const base = quotaState(true);
    const exhausted = base.providers[0]!;
    const account = (id: string, label: string | null, isExhausted: boolean, extra = {}) => ({
      id, label, freshness: 'fresh' as const, updatedAt: exhausted.updatedAt, validUntil: exhausted.validUntil,
      exhausted: isExhausted, summaryWindowId: 'codex.weekly',
      windows: [
        { ...exhausted.windows[0]!, percentUsed: isExhausted ? 100 : 10, exhausted: isExhausted },
        { id: 'codex.weekly', label: 'Weekly', percentUsed: 55, resetsAt: null, exhausted: false },
      ],
      ...extra,
    });
    gateway.quota.mockResolvedValue({ ...base, providers: [{ ...exhausted,
      accounts: [account('legacy', 'Main', true), account('spare', 'Spare', false)] }] });
    TestBed.tick();
    await vi.waitFor(() => expect(store.providers()[0]?.accounts).toHaveLength(2));
    expect(store.providers()[0]!.accounts.map(item => [item.label, item.headlinePercent])).toEqual([['Main', 55], ['Spare', 55]]);
    expect(store.isExhausted('codex')).toBe(false);

    gateway.quotaEvent.set({ hostId: 'a', data: { ...base, providers: [{ ...exhausted,
      accounts: [account('legacy', 'Main', true), account('spare', 'Spare (disabled)', false, { disabled: true })] }] } });
    TestBed.tick();
    expect(store.isExhausted('codex')).toBe(true);
  });

  it('treats a host without account usage as one unnamed account', async () => {
    const { store } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.providers()[0]?.accounts).toHaveLength(1));
    expect(store.providers()[0]!.accounts[0]).toMatchObject({ id: 'legacy', label: null, headlinePercent: 100, exhausted: true });
  });
});
