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
});
