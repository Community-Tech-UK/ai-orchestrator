import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import type { MobileServerEvent, MobileSnapshot, PairedHost } from './models';

const HOST: PairedHost = {
  id: 'host-one', name: 'Example host', host: 'example.invalid', port: 8899,
  token: 'TEST_ONLY_PLACEHOLDER', addedAt: 0,
};
const SNAPSHOT: MobileSnapshot = {
  hostName: 'Example host', serverTime: 0, projects: [], prompts: [],
  pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  instances: [{
    id: 'session', displayName: 'Example session', provider: 'codex', status: 'busy',
    workingDirectory: '/example', projectName: 'Example', createdAt: 0, lastActivity: 0,
    pendingApprovalCount: 0, hasUnreadCompletion: false,
    queuedMessages: [
      { id: 'q1', message: 'First', hasAttachments: true, enqueuedAt: 0, attempts: 0 },
      { id: 'q2', message: 'Second', hasAttachments: false, enqueuedAt: 1, attempts: 0 },
    ],
  }],
};

function setup() {
  const activeHost = signal(HOST);
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  TestBed.configureTestingModule({ providers: [
    { provide: HostStore, useValue: { hosts: signal([HOST]), activeHost } },
  ] });
  const client = TestBed.inject(GatewayClient);
  const receive = (event: MobileServerEvent) =>
    (client as unknown as { handleEvent(event: MobileServerEvent): void }).handleEvent(event);
  receive({ type: 'snapshot', data: SNAPSHOT });
  return { client, activeHost, fetchMock, receive };
}

afterEach(() => vi.unstubAllGlobals());

describe('GatewayClient queue recovery boundary', () => {
  it('removes only the confirmed item from the visible queue', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'First' })));
    await expect(client.cancelQueued('session', 'q1')).resolves.toEqual({ message: 'First' });
    expect(client.snapshot()?.instances[0].queuedMessages?.map((item) => item.id)).toEqual(['q2']);
  });

  it('keeps the queue and refuses draft recovery when delivery already started', async () => {
    const { client, fetchMock } = setup();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: 'Delivery has already started. Check the conversation before sending it again.',
    }), { status: 409 }));
    await expect(client.cancelQueued('session', 'q1')).rejects.toThrow('Delivery has already started');
    expect(client.snapshot()?.instances[0].queuedMessages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a cancelled draft after host navigation without modifying the new host snapshot', async () => {
    const { client, activeHost, fetchMock, receive } = setup();
    const attachments = [{ name: 'photo.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' }];
    let release!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { release = resolve; }));
    const pending = client.cancelQueued('session', 'q1');
    activeHost.set({ ...HOST, id: 'host-two' });
    const otherSnapshot = { ...SNAPSHOT, hostName: 'Other host' };
    receive({ type: 'snapshot', data: otherSnapshot });
    release(new Response(JSON.stringify({ message: 'First', attachments })));
    await expect(pending).resolves.toEqual({ message: 'First', attachments });
    expect(client.snapshot()).toBe(otherSnapshot);
    expect(client.snapshot()?.instances[0].queuedMessages).toHaveLength(2);
  });
});
