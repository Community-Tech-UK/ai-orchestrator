import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { WorkerStreamDurability } from './worker-stream-durability';
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

describe('WorkerInstanceNotifier registration ordering', () => {
  // Reproduces the reconnect wedge: a worker with an in-flight instance queues
  // `instance.stateChange` frames while the socket is down. On reconnect the
  // registration frame must be FIRST — a queued state-change jumping ahead gets
  // the socket closed with 1008 "Registration required", looping forever.
  function makeGatedNotifier(registered: () => boolean) {
    const socket = new FakeSocket();
    const notifier = new WorkerInstanceNotifier({
      getSocket: () => socket as never,
      getToken: () => 'tok',
      getRegistered: registered,
    });
    return { socket, notifier };
  }

  it('does not send critical state-changes before registration is accepted', () => {
    const { socket, notifier } = makeGatedNotifier(() => false);
    notifier.sendStateChange('inst-1', 'processing');
    notifier.sendExit('inst-2', { code: 0 });
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('sends the registration frame first even with queued state-changes', () => {
    let registered = false;
    const { socket, notifier } = makeGatedNotifier(() => registered);

    // Instances change state while disconnected/unregistered → queued.
    notifier.sendStateChange('inst-1', 'processing');
    notifier.sendStateChange('inst-1', 'processing');
    expect(socket.send).not.toHaveBeenCalled();

    // Registration goes out via send(); its opportunistic flush must NOT drain
    // the critical queue ahead of the registration frame.
    notifier.send({ jsonrpc: '2.0', id: 'reg-1', method: 'node.register', params: {} });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]).method).toBe('node.register');

    // Coordinator accepts → the worker flushes the critical queue.
    registered = true;
    notifier.flushCriticalQueue();
    expect(socket.sent).toHaveLength(2);
    const drained = JSON.parse(socket.sent[1]);
    expect(drained.method).toBe('instance.stateChange');
    expect(drained.params.instanceId).toBe('inst-1');
  });

  it('flushCriticalQueue is a no-op until registered', () => {
    let registered = false;
    const { socket, notifier } = makeGatedNotifier(() => registered);
    notifier.sendStateChange('inst-1', 'processing');
    notifier.flushCriticalQueue();
    expect(socket.send).not.toHaveBeenCalled();

    registered = true;
    notifier.flushCriticalQueue();
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
});

describe('WorkerInstanceNotifier durable-stream integration (WS15)', () => {
  function makeDurableNotifier() {
    const socket = new FakeSocket();
    const durability = new WorkerStreamDurability();
    const notifier = new WorkerInstanceNotifier({
      getSocket: () => socket as never,
      getToken: () => 'tok-current',
      durability,
    });
    return { socket, durability, notifier };
  }

  it('tags single output frames with durableSeq assigned at enqueue time', () => {
    const { socket, notifier } = makeDurableNotifier();
    notifier.sendOutputNotification('inst-1', { type: 'assistant', content: 'hi' });
    notifier.flushOutputBuffer();
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.method).toBe('instance.output');
    expect(frame.params.durableSeq).toBe(1);
  });

  it('tags each batched item with its own durableSeq', () => {
    const { socket, notifier } = makeDurableNotifier();
    notifier.sendOutputNotification('inst-1', { n: 1 });
    notifier.sendOutputNotification('inst-1', { n: 2 });
    notifier.flushOutputBuffer();
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.method).toBe('instance.outputBatch');
    expect(frame.params.items.map((i: { durableSeq: number }) => i.durableSeq)).toEqual([1, 2]);
  });

  it('records context and complete notifications durably', () => {
    const { socket, durability, notifier } = makeDurableNotifier();
    notifier.sendContextNotification('inst-1', { used: 5 });
    notifier.sendCompleteNotification('inst-1', { ok: true });
    expect(JSON.parse(socket.sent[0]).params.durableSeq).toBe(1);
    expect(JSON.parse(socket.sent[1]).params.durableSeq).toBe(2);
    expect(durability.stats().events).toBe(2);
  });

  it('replays after a cursor with replay flag and the CURRENT token', () => {
    const { socket, notifier } = makeDurableNotifier();
    notifier.sendOutputNotification('inst-1', { n: 1 });
    notifier.sendOutputNotification('inst-1', { n: 2 });
    notifier.flushOutputBuffer();
    socket.sent.length = 0;

    const summary = notifier.replayDurableEvents([{ instanceId: 'inst-1', afterSeq: 1 }]);
    expect(summary).toEqual([{ instanceId: 'inst-1', replayed: 1 }]);
    const frame = JSON.parse(socket.sent[0]);
    expect(frame.method).toBe('instance.output');
    expect(frame.params.durableSeq).toBe(2);
    expect(frame.params.replay).toBe(true);
    expect(frame.params.token).toBe('tok-current');
  });

  it('acked events never replay; unacked survive a socket outage', () => {
    const { socket, durability, notifier } = makeDurableNotifier();
    notifier.sendOutputNotification('inst-1', { n: 1 });
    notifier.flushOutputBuffer();
    // Socket goes away; the next event is DROPPED from the wire but recorded durably.
    socket.readyState = 3;
    notifier.sendOutputNotification('inst-1', { n: 2 });
    notifier.flushOutputBuffer();
    durability.ack('inst-1', 1);

    socket.readyState = 1;
    socket.sent.length = 0;
    const summary = notifier.replayDurableEvents([{ instanceId: 'inst-1', afterSeq: 1 }]);
    expect(summary[0].replayed).toBe(1);
    expect(JSON.parse(socket.sent[0]).params.message).toEqual({ n: 2 });
  });
});
