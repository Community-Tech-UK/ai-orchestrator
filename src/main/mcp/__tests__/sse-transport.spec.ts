import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SseTransport } from '../transports/sse-transport';

describe('SseTransport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs with config', () => {
    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    expect(transport.isConnected()).toBe(false);
  });

  it('emits connected on successful connection', async () => {
    // Use a stream that stays open so isConnected() remains true after connect()
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const mockReadable = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: http://localhost:3000/message\n\n'));
        // Do NOT close — keep stream open so connected stays true
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(mockReadable, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    const connectedPromise = new Promise<void>(resolve => transport.once('connected', resolve));
    await transport.connect();
    await connectedPromise;
    expect(transport.isConnected()).toBe(true);

    // Clean up by closing the stream
    streamController!.close();
  });

  it('parses SSE messages', async () => {
    const mockReadable = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n'));
        controller.close();
      },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(mockReadable, { status: 200 }),
    );

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    const messagePromise = new Promise<unknown>(resolve => transport.once('message', resolve));
    await transport.connect();
    const msg = await messagePromise;
    expect(msg).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  });

  it('sends messages via POST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/message',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('disconnects cleanly', () => {
    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });

  it('throws on non-ok SSE response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 503, statusText: 'Service Unavailable' }),
    );

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    await expect(transport.connect()).rejects.toThrow('SSE connection failed: 503');
  });

  it('throws when SSE response has no body', async () => {
    // Mock a response-like object where body is null (body is a getter-only on Response)
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
    } as unknown as Response;

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockResponse);

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    await expect(transport.connect()).rejects.toThrow('SSE response has no body');
  });

  it('throws when send returns non-ok status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 400 }),
    );

    const transport = new SseTransport({ url: 'http://localhost:3000/sse' });
    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow('SSE send failed: 400');
  });
});
