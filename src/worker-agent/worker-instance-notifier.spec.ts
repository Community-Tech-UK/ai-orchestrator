import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WORKER_NODE_WS_MAX_PAYLOAD_BYTES } from '../main/remote-node/rpc-schemas';

// Minimal ws stand-in: OPEN, records sent frames.
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send = vi.fn((data: string, cb?: (err?: Error) => void) => {
    this.sent.push(data);
    cb?.();
  });
}

vi.mock('ws', () => ({ WebSocket: { OPEN: 1 } }));

describe('WorkerInstanceNotifier oversized-frame protection', () => {
  let socket: FakeSocket;
  let notifier: WorkerInstanceNotifier;

  beforeEach(() => {
    socket = new FakeSocket();
    notifier = new WorkerInstanceNotifier({
      getSocket: () => socket as never,
      getToken: () => 'tok',
    });
  });

  it('truncates a single oversized instance.output message instead of sending it whole', () => {
    // ~20 MB string — well over the 8 MB per-message cap but under the 512 MB
    // JSON.stringify ceiling, mirroring an agent reading a huge log file.
    const huge = 'x'.repeat(20 * 1024 * 1024);
    notifier.sendOutputNotification('inst-1', { type: 'assistant', content: huge });
    notifier.flushOutputBuffer();

    expect(socket.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(socket.sent[0]) as {
      method: string;
      params: { message: { truncated?: boolean; content: string } };
    };
    expect(payload.method).toBe('instance.output');
    expect(payload.params.message.truncated).toBe(true);
    expect(payload.params.message.content).toContain('Output omitted');
    // The frame must be far smaller than the payload ceiling now.
    expect(Buffer.byteLength(socket.sent[0], 'utf-8')).toBeLessThan(64 * 1024);
  });

  it('passes a normal-sized output message through unchanged', () => {
    notifier.sendOutputNotification('inst-1', { type: 'assistant', content: 'hi' });
    notifier.flushOutputBuffer();

    const payload = JSON.parse(socket.sent[0]) as {
      params: { message: { content: string; truncated?: boolean } };
    };
    expect(payload.params.message.content).toBe('hi');
    expect(payload.params.message.truncated).toBeUndefined();
  });

  it('drops an outbound frame that exceeds the coordinator payload ceiling', () => {
    // Build a frame whose serialization exceeds the ceiling. capOutputMessage is
    // bypassed by using a non-output method via send() directly.
    const overCeiling = 'y'.repeat(WORKER_NODE_WS_MAX_PAYLOAD_BYTES + 1024);
    const sent = notifier.send({
      jsonrpc: '2.0',
      method: 'some.method',
      params: { blob: overCeiling },
    });

    expect(sent).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('drops an unserializable (circular) frame without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const sent = notifier.send({
      jsonrpc: '2.0',
      method: 'some.method',
      params: circular,
    });

    expect(sent).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
  });
});
