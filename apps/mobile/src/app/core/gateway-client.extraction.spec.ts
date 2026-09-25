import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import type { MobileMessageDto, PairedHost } from './models';

const HOST: PairedHost = {
  id: 'host-a', name: 'Preview', host: 'preview.invalid', port: 8899,
  token: 'PREVIEW_ONLY', addedAt: 0,
};

class SocketDouble {
  static readonly OPEN = 1;
  static readonly sockets: SocketDouble[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 0;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) { SocketDouble.sockets.push(this); }
  open(): void { this.readyState = SocketDouble.OPEN; this.onopen?.(); }
  close(): void { this.readyState = 3; }
  receive(
    instanceId: string,
    seq: number,
    message: MobileMessageDto,
    cursor?: {
      streamSeq: number;
      bufferIndex: number;
      bufferGeneration?: number;
      cursorEpoch?: string;
      adapterGeneration?: number;
    },
  ): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'instance-output', data: { instanceId, seq, message, ...cursor } }),
    } as MessageEvent);
  }
  send(frame: string): void { this.sent.push(JSON.parse(frame)); }
}

function message(id: string): MobileMessageDto {
  return { id, timestamp: 100, type: 'assistant', content: id };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function isFullMessagesUrl(url: string): boolean {
  return new URL(url).pathname.endsWith('/messages') && !url.includes('fromSeq=');
}

function setup(fetcher: (url: string) => Promise<Response>) {
  SocketDouble.sockets.length = 0;
  vi.stubGlobal('WebSocket', SocketDouble);
  vi.stubGlobal('fetch', vi.fn(fetcher));
  TestBed.configureTestingModule({ providers: [
    { provide: HostStore, useValue: { activeHost: signal(HOST), hosts: signal([HOST]) } },
  ] });
  const client = TestBed.inject(GatewayClient);
  TestBed.tick();
  const socket = SocketDouble.sockets[0];
  socket.open();
  return { client, socket };
}

afterEach(() => vi.unstubAllGlobals());

describe('GatewayClient extraction boundaries', () => {
  it('keeps a live frame received during gap replay when the response resolves', async () => {
    let finish!: (response: Response) => void;
    const replay = new Promise<Response>((resolve) => { finish = resolve; });
    const { client, socket } = setup(async (url) => isFullMessagesUrl(url) ? replay : response([]));
    socket.receive('session', 10, message('first'));
    socket.receive('session', 11, message('second'));
    socket.receive('session', 13, message('third'));
    socket.receive('session', 14, message('fourth'));
    finish(response([message('first'), message('second'), message('third')]));
    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['first', 'second', 'third', 'fourth']));
  });

  it('preserves cached transcript and reasserts the viewed session on same-host reconnect', () => {
    const { client, socket } = setup(async () => response([]));
    socket.receive('session', 1, message('cached'));
    client.setActiveView('session');
    client.reconnect();
    const replacement = SocketDouble.sockets[1];
    replacement.open();
    expect(client.messagesFor('session').map((item) => item.id)).toEqual(['cached']);
    expect(replacement.sent).toContainEqual({ type: 'view', instanceId: 'session' });
    expect(client.state()).toBe('connected');
  });

  it('resumes from the last HTTP-loaded buffer index after reconnect', async () => {
    const messageRequests: string[] = [];
    const { client } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('fromSeq=7')) {
        return response({
          messages: [],
          meta: { fromSeq: 7, returned: 0, hasMore: false, maxSeq: 7, bufferGeneration: 0 },
        });
      }
      if (isFullMessagesUrl(url)) return response([{ ...message('loaded'), seq: 7 }]);
      return response([]);
    });

    await client.loadMessages('session');
    client.setActiveView('session');
    client.reconnect();
    SocketDouble.sockets[1].open();

    await vi.waitFor(() => expect(messageRequests).toContain(
      'http://preview.invalid:8899/api/instances/session/messages?fromSeq=7&includeFrom=1',
    ));
  });

  it('detects the first generation change after an HTTP-loaded transcript', async () => {
    const messageRequests: string[] = [];
    let fullLoads = 0;
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('withCursor=1')) {
        fullLoads += 1;
        return response(fullLoads === 1 ? {
          messages: [{ ...message('old'), seq: 0 }],
          meta: {
            fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
            bufferGeneration: 1, adapterGeneration: 1,
          },
        } : {
          messages: [{ ...message('authoritative'), seq: 0 }],
          meta: {
            fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
            bufferGeneration: 2, adapterGeneration: 2,
          },
        });
      }
      if (isFullMessagesUrl(url)) return response([{ ...message('old'), seq: 0 }]);
      return response([]);
    });

    await client.loadMessages('session');
    socket.receive('session', 1, message('new-live'), {
      streamSeq: 0, bufferIndex: 0, bufferGeneration: 2, adapterGeneration: 2,
    });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative']));
    expect(messageRequests.filter((url) => url.includes('withCursor=1'))).toHaveLength(2);
  });

  it('retries when a replacement frame arrives during the initial HTTP load', async () => {
    let finishStaleLoad!: (response: Response) => void;
    const staleLoad = new Promise<Response>((resolve) => { finishStaleLoad = resolve; });
    let fullLoads = 0;
    const { client, socket } = setup(async (url) => {
      if (!url.includes('withCursor=1')) return response([]);
      fullLoads += 1;
      if (fullLoads === 1) return staleLoad;
      return response({
        messages: [{ ...message('new-live'), seq: 0 }],
        meta: {
          fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
          bufferGeneration: 2, adapterGeneration: 2,
        },
      });
    });

    const loading = client.loadMessages('session');
    await vi.waitFor(() => expect(fullLoads).toBe(1));
    socket.receive('session', 1, message('new-live'), {
      streamSeq: 0, bufferIndex: 0, bufferGeneration: 2, adapterGeneration: 2,
    });
    finishStaleLoad(response({
      messages: [{ ...message('old'), seq: 0 }],
      meta: {
        fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
        bufferGeneration: 1, adapterGeneration: 1,
      },
    }));
    await loading;

    expect(fullLoads).toBe(2);
    expect(client.messagesFor('session').map((item) => item.id)).toEqual(['new-live']);
  });

  it('keeps the newer same-generation live cursor when an HTTP load resolves', async () => {
    let finishLoad!: (response: Response) => void;
    const pendingLoad = new Promise<Response>((resolve) => { finishLoad = resolve; });
    const messageRequests: string[] = [];
    let fullLoads = 0;
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('withCursor=1')) {
        fullLoads += 1;
        if (fullLoads === 1) return pendingLoad;
      }
      if (url.includes('fromSeq=6')) {
        return response({
          messages: [],
          meta: {
            fromSeq: 6, returned: 0, hasMore: false, maxSeq: 6,
            bufferGeneration: 1, adapterGeneration: 1,
          },
        });
      }
      return response([]);
    });

    const loading = client.loadMessages('session');
    socket.receive('session', 1, { ...message('live'), seq: 6 }, {
      streamSeq: 0, bufferIndex: 6, bufferGeneration: 1, adapterGeneration: 1,
    });
    finishLoad(response({
      messages: [{ ...message('old'), seq: 5 }],
      meta: {
        fromSeq: -1, returned: 1, hasMore: false, maxSeq: 5,
        bufferGeneration: 1, adapterGeneration: 1,
      },
    }));
    await loading;
    client.setActiveView('session');
    client.reconnect();
    SocketDouble.sockets[1].open();

    await vi.waitFor(() => expect(messageRequests).toContain(
      'http://preview.invalid:8899/api/instances/session/messages?fromSeq=6&includeFrom=1',
    ));
  });

  it('keeps an authoritative streaming revision covered by the full-response watermark', async () => {
    let finishLoad!: (response: Response) => void;
    const pendingLoad = new Promise<Response>((resolve) => { finishLoad = resolve; });
    const { client, socket } = setup(async (url) =>
      url.includes('withCursor=1') ? pendingLoad : response([]));

    const loading = client.loadMessages('session');
    socket.receive('session', 1, { ...message('stream'), content: 'Hel' }, {
      streamSeq: 0, bufferIndex: 0, bufferGeneration: 1, adapterGeneration: 1,
    });
    finishLoad(response({
      messages: [{ ...message('stream'), content: 'Hello', seq: 0 }],
      meta: {
        fromSeq: -1, returned: 1, hasMore: false, maxSeq: 0,
        bufferGeneration: 1, adapterGeneration: 1, streamSeq: 0,
      },
    }));
    await loading;

    expect(client.messagesFor('session').map((item) => item.content)).toEqual(['Hello']);
  });

  it('does not refetch when legacy provider seq skips but output streamSeq is contiguous', async () => {
    const messageRequests: string[] = [];
    const { socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      return response([]);
    });

    socket.receive('session', 4, message('first'), { streamSeq: 0, bufferIndex: 0, adapterGeneration: 1 });
    socket.receive('session', 9, message('second'), { streamSeq: 1, bufferIndex: 1, adapterGeneration: 1 });
    await Promise.resolve();

    expect(messageRequests).toEqual([]);
  });

  it('repairs one missed output with one fromSeq request', async () => {
    const messageRequests: string[] = [];
    const replay = {
      messages: [{ ...message('missing'), seq: 1 }],
      meta: { fromSeq: 0, returned: 1, hasMore: false, maxSeq: 1, bufferGeneration: 0, adapterGeneration: 1 },
    };
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      return response(url.includes('fromSeq=0') ? replay : []);
    });

    socket.receive('session', 1, message('first'), { streamSeq: 0, bufferIndex: 0, bufferGeneration: 0, adapterGeneration: 1 });
    socket.receive('session', 3, message('third'), { streamSeq: 2, bufferIndex: 2, bufferGeneration: 0, adapterGeneration: 1 });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['first', 'missing', 'third']));
    expect(messageRequests).toEqual([
      'http://preview.invalid:8899/api/instances/session/messages?fromSeq=0&includeFrom=1',
    ]);
  });

  it('replays the last buffer entry inclusively when a streaming revision was missed', async () => {
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('includeFrom=1')) {
        return response({
          messages: [
            { ...message('stream'), content: 'Hello', seq: 0 },
            { ...message('next'), seq: 1 },
          ],
          meta: {
            fromSeq: 0, returned: 2, hasMore: false, maxSeq: 1,
            bufferGeneration: 0, adapterGeneration: 1, streamSeq: 2,
          },
        });
      }
      return response([]);
    });

    socket.receive('session', 1, { ...message('stream'), content: 'Hel' }, {
      streamSeq: 0, bufferIndex: 0, bufferGeneration: 0, adapterGeneration: 1,
    });
    socket.receive('session', 3, message('next'), {
      streamSeq: 2, bufferIndex: 1, bufferGeneration: 0, adapterGeneration: 1,
    });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.content))
      .toEqual(['Hello', 'next']));
    expect(messageRequests).toEqual([
      'http://preview.invalid:8899/api/instances/session/messages?fromSeq=0&includeFrom=1',
    ]);
  });

  it('falls back to a full transcript when incremental replay has more pages', async () => {
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('fromSeq=0')) {
        return response({
          messages: [{ ...message('missing'), seq: 1 }],
          meta: { fromSeq: 0, returned: 1, hasMore: true, maxSeq: 1, bufferGeneration: 0 },
        });
      }
      return response([{ ...message('authoritative'), seq: 8 }]);
    });

    socket.receive('session', 1, message('first'), { streamSeq: 0, bufferIndex: 0, bufferGeneration: 0 });
    socket.receive('session', 4, message('third'), { streamSeq: 2, bufferIndex: 2, bufferGeneration: 0 });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative']));
    expect(messageRequests).toEqual([
      'http://preview.invalid:8899/api/instances/session/messages?fromSeq=0&includeFrom=1',
      'http://preview.invalid:8899/api/instances/session/messages?withCursor=1',
    ]);
  });

  it('retains a live frame received while incremental replay falls back to a full transcript', async () => {
    let finishFull!: (response: Response) => void;
    const fullResponse = new Promise<Response>((resolve) => { finishFull = resolve; });
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('fromSeq=0')) {
        return response({
          messages: [{ ...message('missing'), seq: 1 }],
          meta: { fromSeq: 0, returned: 1, hasMore: true, maxSeq: 1, bufferGeneration: 0 },
        });
      }
      if (isFullMessagesUrl(url)) return fullResponse;
      return response([]);
    });

    socket.receive('session', 1, message('first'), { streamSeq: 0, bufferIndex: 0, bufferGeneration: 0 });
    socket.receive('session', 3, message('third'), { streamSeq: 2, bufferIndex: 2, bufferGeneration: 0 });
    await vi.waitFor(() => expect(messageRequests).toHaveLength(2));
    socket.receive('session', 4, message('live'), { streamSeq: 3, bufferIndex: 3, bufferGeneration: 0 });
    finishFull(response([{ ...message('authoritative'), seq: 2 }]));

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative', 'live']));
  });

  it('retains a live frame received before incremental replay requests a full fallback', async () => {
    let finishReplay!: (response: Response) => void;
    let finishFull!: (response: Response) => void;
    const replayResponse = new Promise<Response>((resolve) => { finishReplay = resolve; });
    const fullResponse = new Promise<Response>((resolve) => { finishFull = resolve; });
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      if (url.includes('fromSeq=0')) return replayResponse;
      if (isFullMessagesUrl(url)) return fullResponse;
      return response([]);
    });

    socket.receive('session', 1, message('first'), { streamSeq: 0, bufferIndex: 0, bufferGeneration: 0 });
    socket.receive('session', 3, message('third'), { streamSeq: 2, bufferIndex: 2, bufferGeneration: 0 });
    await vi.waitFor(() => expect(messageRequests).toHaveLength(1));
    socket.receive('session', 4, message('live'), { streamSeq: 3, bufferIndex: 3, bufferGeneration: 0 });
    finishReplay(response({
      messages: [{ ...message('missing'), seq: 1 }],
      meta: { fromSeq: 0, returned: 1, hasMore: true, maxSeq: 1, bufferGeneration: 0 },
    }));
    await vi.waitFor(() => expect(messageRequests).toHaveLength(2));
    finishFull(response([{ ...message('authoritative'), seq: 2 }]));

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative', 'live']));
  });

  it('fully reloads when the provider adapter generation changes', async () => {
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      return response([{ ...message('after-respawn'), seq: 4 }]);
    });

    socket.receive('session', 1, message('before'), { streamSeq: 0, bufferIndex: 0, bufferGeneration: 0, adapterGeneration: 1 });
    socket.receive('session', 2, message('after'), { streamSeq: 1, bufferIndex: 1, bufferGeneration: 0, adapterGeneration: 2 });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['after-respawn']));
    expect(messageRequests).toEqual([
      'http://preview.invalid:8899/api/instances/session/messages?withCursor=1',
    ]);
  });

  it('fully reloads instead of dropping valid output after a gateway cursor restart', async () => {
    const messageRequests: string[] = [];
    const { client, socket } = setup(async (url) => {
      if (url.includes('/messages')) messageRequests.push(url);
      return response([{ ...message('authoritative-after-restart'), seq: 0 }]);
    });

    socket.receive('session', 10, message('before-restart'), {
      streamSeq: 10,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
    });
    socket.receive('session', 1, message('first-after-restart'), {
      streamSeq: 0,
      bufferIndex: 0,
      bufferGeneration: 0,
      adapterGeneration: 1,
      cursorEpoch: 'gateway-after-restart',
    });

    await vi.waitFor(() => expect(client.messagesFor('session').map((item) => item.id))
      .toEqual(['authoritative-after-restart']));
    expect(messageRequests).toEqual([
      'http://preview.invalid:8899/api/instances/session/messages?withCursor=1',
    ]);
  });
});
