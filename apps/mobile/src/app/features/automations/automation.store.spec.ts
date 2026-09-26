import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileAutomationDto } from '../../core/models';
import { AutomationStore } from './automation.store';

const ITEM: MobileAutomationDto = {
  id: 'daily-review', name: 'Daily review', enabled: true, nextRunAt: 20,
  schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Europe/London' },
  lastRun: { status: 'succeeded', at: 10 }, provider: 'codex', model: 'gpt-5.4',
};

function setup() {
  const activeHost = signal({ id: 'a', name: 'Host A' });
  const online = signal(true);
  const dataHostId = signal('a');
  const connectionEpoch = signal(1);
  const gateway = {
    online, dataHostId, connectionEpoch,
    automations: vi.fn<() => Promise<MobileAutomationDto[]>>().mockResolvedValue([ITEM]),
    runAutomation: vi.fn().mockResolvedValue({ status: 'started', runId: 'run-1' }),
  };
  TestBed.configureTestingModule({ providers: [
    { provide: HostStore, useValue: { activeHost } },
    { provide: GatewayClient, useValue: gateway },
  ] });
  return { store: TestBed.inject(AutomationStore), activeHost, dataHostId, connectionEpoch, gateway };
}

afterEach(() => TestBed.resetTestingModule());

describe('host-scoped AutomationStore', () => {
  it('blocks a cached item while a same-host authority refresh is pending', async () => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    let release!: (items: MobileAutomationDto[]) => void;
    gateway.automations.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const refresh = store.refresh();
    await store.runNow(ITEM);
    expect(gateway.runAutomation).not.toHaveBeenCalled();
    release([{ ...ITEM }]); await refresh;
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation).toHaveBeenCalledTimes(1);
  });

  it('closes list authority in the reconnect window until a fresh list lands', async () => {
    const { store, connectionEpoch, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    gateway.online.set(false); TestBed.tick();
    // The socket opens a new connection attempt before it reports 'connected'.
    connectionEpoch.set(connectionEpoch() + 1);
    gateway.online.set(true);
    // No effect flush yet: the cached pre-outage list is not authority here.
    expect(store.hasCurrentList()).toBe(false);
    await store.runNow(ITEM);
    expect(gateway.runAutomation).not.toHaveBeenCalled();
    TestBed.tick();
    await vi.waitFor(() => expect(store.hasCurrentList()).toBe(true));
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation).toHaveBeenCalledTimes(1);
  });

  it('drops a pre-outage list response that lands after a reconnect', async () => {
    const { store, connectionEpoch, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    let release!: (items: MobileAutomationDto[]) => void;
    gateway.automations.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const inflight = store.refresh();
    gateway.online.set(false);
    connectionEpoch.set(connectionEpoch() + 1);
    gateway.online.set(true);
    release([{ ...ITEM, name: 'Renamed while offline' }]);
    await inflight;
    // The response began under the previous connection; it cannot authorize sends.
    expect(store.hasCurrentList()).toBe(false);
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation).not.toHaveBeenCalled();
    TestBed.tick();
    await vi.waitFor(() => expect(store.automations()[0]?.name).toBe('Daily review'));
    expect(store.hasCurrentList()).toBe(true);
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation).toHaveBeenCalledTimes(1);
  });
  it.each(['removed', 'disabled'])('ends an uncertain intent when the authoritative record is %s', async change => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    gateway.runAutomation.mockRejectedValue(new Error('Response lost'));
    await store.runNow(ITEM);
    const key = gateway.runAutomation.mock.calls[0][1];
    gateway.automations.mockResolvedValue(change === 'removed' ? [] : [{ ...ITEM, enabled: false }]);
    await store.refresh();
    expect(store.feedbackFor(ITEM.id)).toBeNull();
    gateway.automations.mockResolvedValue([{ ...ITEM }]); await store.refresh();
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation.mock.calls[1][1]).not.toBe(key);
  });
  it('rejects a stale item across a host switch and a replaced same-id list item without sending', async () => {
    const { store, activeHost, dataHostId, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    activeHost.set({ id: 'b', name: 'Host B' });
    await store.runNow(ITEM);
    expect(gateway.runAutomation).not.toHaveBeenCalled();
    gateway.automations.mockResolvedValue([{ ...ITEM }]); dataHostId.set('b'); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toHaveLength(1));
    await store.runNow(ITEM);
    expect(gateway.runAutomation).not.toHaveBeenCalled();
  });

  it('reuses one intent key after a request fires but its response is lost', async () => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    const fired = new Set<string>();
    const keys: string[] = [];
    gateway.runAutomation.mockImplementation(async (_id: string, key: string) => {
      keys.push(key); fired.add(key);
      if (keys.length === 1) throw new Error('Response lost after dispatch');
      return { status: 'started', runId: 'one-logical-run' };
    });
    await store.runNow(ITEM);
    expect(store.running(ITEM.id)).toBe(false);
    await store.runNow(ITEM);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(fired.size).toBe(1);
    expect(store.feedbackFor(ITEM.id)).toBe('Started');
  });

  it('cancels pending/result ownership and rotates a cancelled or definitively completed intent', async () => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    let release!: (outcome: { status: string; runId: string }) => void;
    gateway.runAutomation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = store.runNow(ITEM);
    const firstKey = gateway.runAutomation.mock.calls[0][1];
    expect(store.running(ITEM.id)).toBe(true);
    await store.runNow(ITEM);
    expect(gateway.runAutomation).toHaveBeenCalledTimes(1);
    store.cancelRun();
    expect(store.running(ITEM.id)).toBe(false);
    release({ status: 'started', runId: 'late' }); await pending;
    expect(store.feedbackFor(ITEM.id)).toBeNull();
    await store.runNow(ITEM);
    const secondKey = gateway.runAutomation.mock.calls[1][1];
    expect(secondKey).not.toBe(firstKey);
    await store.runNow(ITEM);
    expect(gateway.runAutomation.mock.calls[2][1]).not.toBe(secondKey);
  });

  it('keeps uncertain intent across reconnect but rotates it when the automation changes', async () => {
    const { store, connectionEpoch, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    gateway.runAutomation.mockRejectedValue(new Error('Uncertain transport result'));
    await store.runNow(ITEM);
    const key = gateway.runAutomation.mock.calls[0][1];
    gateway.online.set(false); TestBed.tick();
    connectionEpoch.set(connectionEpoch() + 1); gateway.online.set(true); TestBed.tick();
    await vi.waitFor(() => expect(store.hasCurrentList()).toBe(true));
    await store.runNow(ITEM);
    expect(gateway.runAutomation.mock.calls[1][1]).toBe(key);
    const other = { ...ITEM, id: 'another-job' };
    gateway.automations.mockResolvedValue([ITEM, other]); await store.refresh();
    await store.runNow(other);
    expect(gateway.runAutomation.mock.calls[2][1]).not.toBe(key);
    await store.runNow(ITEM);
    expect(gateway.runAutomation.mock.calls[3][1]).not.toBe(key);
  });
  it('loads automations and clears them synchronously when the host changes', async () => {
    const { store, activeHost } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    activeHost.set({ id: 'b', name: 'Host B' });
    expect(store.automations()).toEqual([]);
  });

  it('ignores a departed host response', async () => {
    const { store, activeHost, dataHostId, gateway } = setup();
    let release!: (items: MobileAutomationDto[]) => void;
    gateway.automations.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    TestBed.tick();
    activeHost.set({ id: 'b', name: 'Host B' }); dataHostId.set('b');
    gateway.automations.mockResolvedValue([]); TestBed.tick();
    release([ITEM]); await Promise.resolve();
    expect(store.automations()).toEqual([]);
  });

  it('uses one idempotency key for the confirmed request and exposes the exact outcome', async () => {
    const { store, gateway } = setup(); TestBed.tick();
    await vi.waitFor(() => expect(store.automations()).toEqual([ITEM]));
    await store.runNow(ITEM);
    const key = gateway.runAutomation.mock.calls[0][1];
    expect(key).toMatch(/^mobile-/);
    expect(store.feedbackFor('daily-review')).toBe('Started');
    expect(gateway.runAutomation).toHaveBeenCalledTimes(1);
    expect(store.running('daily-review')).toBe(false);
  });
});
