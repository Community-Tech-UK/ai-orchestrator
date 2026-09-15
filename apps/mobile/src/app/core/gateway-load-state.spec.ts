import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import type { PairedHost } from './models';
import { MOBILE_REQUEST_TIMEOUT_MS } from './gateway-request-state';

const HOST: PairedHost = { id: 'preview-host', name: 'Preview', host: 'preview.invalid', port: 8899, token: 'PREVIEW_ONLY', addedAt: 0 };
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function setup() {
  const activeHost = signal<PairedHost | null>(HOST);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  TestBed.configureTestingModule({ providers: [{ provide: HostStore, useValue: { activeHost, hosts: signal([HOST]) } }] });
  return { client: TestBed.inject(GatewayClient), fetchMock, activeHost };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('GatewayClient load state and host isolation', () => {
  it('distinguishes failed loading from successfully loaded empty content and retains cached messages', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(response([{ id: 'm1', content: 'Cached', type: 'assistant', timestamp: 1 }]));
    await client.loadMessages('session');
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await client.loadMessages('session');
    expect(client.messagesFor('session')[0]?.content).toBe('Cached');
    expect(client.messageStateFor('session').status).toBe('error');
    expect(client.messageStateFor('session').error).toMatch(/host|connection/i);
    fetchMock.mockResolvedValueOnce(response([]));
    await client.loadMessages('session');
    expect(client.messageStateFor('session').status).toBe('loaded');
    expect(client.messagesFor('session')).toEqual([]);
  });

  it('does not let an older request overwrite a newer transcript', async () => {
    const { client, fetchMock } = setup();
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    const older = client.loadMessages('session');
    fetchMock.mockResolvedValueOnce(response([{ id: 'new', content: 'New', type: 'assistant', timestamp: 2 }]));
    await client.loadMessages('session');
    release(response([]));
    await older;
    expect(client.messagesFor('session')[0]?.content).toBe('New');
  });

  it('rejects stale successful commands after the active host changes', async () => {
    const { client, fetchMock, activeHost } = setup();
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    const pending = client.setPause(true);
    activeHost.set({ ...HOST, id: 'second-preview' });
    release(response({ isPaused: true, reasons: [], pausedAt: 1, lastChange: 1 }));
    await expect(pending).rejects.toThrow(/host changed/i);
    expect(client.pause().isPaused).toBe(false);
  });

  it('keeps failed history loading visible without clearing usable cache', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(response([{ id: 'past' }]));
    await client.loadHistory();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await client.loadHistory();
    expect(client.historySessions()[0]?.id).toBe('past');
    expect(client.historyState().status).toBe('error');
  });

  it.each(['pause', 'models'] as const)('checks %s ownership again at the state mutation boundary', async (operation) => {
    const { client, fetchMock, activeHost } = setup();
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    fetchMock.mockResolvedValue({ ok: true, json: () => {
      entered(); return new Promise((resolve) => { release = resolve; });
    } });
    const pending = operation === 'pause' ? client.setPause(true) : client.models();
    await reading;
    release(operation === 'pause' ? { isPaused: true, reasons: [], pausedAt: 1, lastChange: 1 } : { claude: [] });
    queueMicrotask(() => activeHost.set({ ...HOST, id: 'host-b' }));
    await pending.catch(() => undefined);
    expect(client.pause().isPaused).toBe(false);
    expect(client.modelCatalog()).toBeNull();
  });

  it.each(['response', 'body'] as const)('bounds a stalled %s without retrying or accepting a late state change', async (stall) => {
    const { client, fetchMock } = setup();
    vi.useFakeTimers();
    let release!: (value: unknown) => void;
    const blocked = new Promise((resolve) => { release = resolve; });
    fetchMock.mockReturnValue(stall === 'response' ? blocked : Promise.resolve({ ok: true, json: () => blocked }));
    const pending = client.setPause(true);
    const rejected = expect(pending).rejects.toThrow(/timed out.*not confirmed/i);
    await vi.advanceTimersByTimeAsync(MOBILE_REQUEST_TIMEOUT_MS + 1);
    await rejected;
    const writes = fetchMock.mock.calls.filter((call) => call[1].method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0][1].signal.aborted).toBe(true);
    const late = { isPaused: true, reasons: [], pausedAt: 1, lastChange: 1 };
    release(stall === 'response' ? response(late) : late);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.pause().isPaused).toBe(false);
  });
});
