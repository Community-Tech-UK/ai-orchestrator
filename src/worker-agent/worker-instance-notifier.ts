import { WebSocket } from 'ws';
import {
  NODE_TO_COORDINATOR,
} from '../main/remote-node/worker-node-rpc';
import { WORKER_NODE_WS_MAX_PAYLOAD_BYTES } from '../main/remote-node/rpc-schemas';
import type { RpcMessage } from './worker-rpc-types';

interface WorkerInstanceNotifierOptions {
  getSocket: () => WebSocket | null;
  getToken: () => string | undefined;
}

interface WorkerInstanceNotifierSendOptions {
  highWatermarkBytes?: number;
}

export class WorkerInstanceNotifier {
  private outputBuffer: { instanceId: string; message: unknown }[] = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private criticalMessageQueue: RpcMessage[] = [];
  private criticalSeq = 0;

  private static readonly OUTPUT_BATCH_INTERVAL_MS = 50;
  private static readonly OUTPUT_BATCH_MAX_SIZE = 10;
  private static readonly CRITICAL_QUEUE_MAX_SIZE = 100;

  /**
   * Hard ceiling on a single outbound frame. The coordinator's receive socket
   * uses `WORKER_NODE_WS_MAX_PAYLOAD_BYTES` as its `maxPayload`, so a frame at or
   * above that size is rejected with WS close code 1009 ("message too big") —
   * which drops the whole worker connection. A frame that big must never reach
   * `ws.send`; we drop it and keep the socket alive instead.
   */
  private static readonly MAX_OUTBOUND_FRAME_BYTES = WORKER_NODE_WS_MAX_PAYLOAD_BYTES;

  /**
   * Per-message cap for `instance.output`. A single tool result (e.g. an agent
   * reading a multi-hundred-MB rclone log — the real incident that crashed a
   * node) can serialize to tens of MB. Truncate it to a small marker so the
   * frame stays well under the payload ceiling and the connection survives.
   */
  private static readonly MAX_INSTANCE_OUTPUT_BYTES = 8 * 1024 * 1024;

  constructor(private readonly options: WorkerInstanceNotifierOptions) {}

  /**
   * Serialize an outbound frame, guarding the two ways serialization can take
   * the process down or drop the connection: a `JSON.stringify` throw (circular
   * refs, or a string exceeding V8's ~512 MB limit) and an over-ceiling frame
   * that the coordinator would reject with 1009. Returns `null` when the frame
   * must be dropped.
   */
  private serializeFrame(msg: RpcMessage): string | null {
    let serialized: string;
    try {
      serialized = JSON.stringify(msg);
    } catch (err) {
      console.error('[WorkerAgent] Failed to serialize outbound frame — dropping', {
        method: msg.method,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (serialized === undefined) {
      return null;
    }
    if (Buffer.byteLength(serialized, 'utf-8') > WorkerInstanceNotifier.MAX_OUTBOUND_FRAME_BYTES) {
      console.warn('[WorkerAgent] Dropping oversized outbound frame to protect the connection', {
        method: msg.method,
        bytes: Buffer.byteLength(serialized, 'utf-8'),
        capBytes: WorkerInstanceNotifier.MAX_OUTBOUND_FRAME_BYTES,
      });
      return null;
    }
    return serialized;
  }

  /**
   * Cap a single `instance.output` message payload. If serializing the message
   * exceeds the per-message ceiling, replace it with a small truncation marker
   * so the batch/single frame never balloons past the socket payload limit.
   */
  private capOutputMessage(instanceId: string, message: unknown): unknown {
    let bytes: number;
    try {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) {
        return message;
      }
      bytes = Buffer.byteLength(serialized, 'utf-8');
    } catch (err) {
      console.warn('[WorkerAgent] Dropping unserializable instance-output message', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        type: 'system',
        truncated: true,
        content: '⚠️ Output dropped — a message could not be serialized.',
      };
    }
    if (bytes <= WorkerInstanceNotifier.MAX_INSTANCE_OUTPUT_BYTES) {
      return message;
    }
    const mb = (n: number): number => Math.round((n / (1024 * 1024)) * 10) / 10;
    console.warn('[WorkerAgent] Truncating oversized instance-output message', {
      instanceId,
      bytes,
      capBytes: WorkerInstanceNotifier.MAX_INSTANCE_OUTPUT_BYTES,
    });
    return {
      type: 'system',
      truncated: true,
      originalBytes: bytes,
      content:
        `⚠️ Output omitted — a single message was ${mb(bytes)} MB, over the ` +
        `${mb(WorkerInstanceNotifier.MAX_INSTANCE_OUTPUT_BYTES)} MB per-message cap. ` +
        'This usually means a tool returned an enormous payload (e.g. reading a huge ' +
        'log file). The content was dropped to keep the worker connection alive.',
    };
  }

  send(msg: RpcMessage, options: WorkerInstanceNotifierSendOptions = {}): boolean {
    const ws = this.options.getSocket();
    if (ws?.readyState !== WebSocket.OPEN) {
      console.warn('[WorkerAgent] Message dropped — WebSocket not open', {
        method: msg.method,
        readyState: ws?.readyState
      });
      return false;
    }

    if (
      options.highWatermarkBytes !== undefined &&
      ws.bufferedAmount > options.highWatermarkBytes
    ) {
      console.warn('[WorkerAgent] Message dropped — WebSocket backpressure exceeded', {
        method: msg.method,
        bufferedAmount: ws.bufferedAmount,
        highWatermarkBytes: options.highWatermarkBytes,
      });
      return false;
    }

    const serialized = this.serializeFrame(msg);
    if (serialized === null) {
      return false;
    }
    this.flushCriticalQueue();
    ws.send(serialized, (err) => {
      if (err) console.error('Send error:', err.message);
    });
    return true;
  }

  sendCritical(msg: RpcMessage): void {
    const serialized = this.serializeFrame(msg);
    if (serialized === null) {
      // Unserializable/oversized critical frame — dropping is safer than
      // crashing. Do not enqueue: it would fail identically on every retry.
      return;
    }
    const ws = this.options.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      this.flushCriticalQueue();
      ws.send(serialized, (err) => {
        if (err) {
          console.warn(
            '[WorkerAgent] Critical send failed, queueing for retry',
            {
              method: msg.method,
              error: err.message
            }
          );
          this.enqueueCriticalMessage(msg);
        }
      });
    } else {
      this.enqueueCriticalMessage(msg);
    }
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  sendOutputNotification(instanceId: string, message: unknown): void {
    this.outputBuffer.push({ instanceId, message: this.capOutputMessage(instanceId, message) });

    if (this.outputBuffer.length >= WorkerInstanceNotifier.OUTPUT_BATCH_MAX_SIZE) {
      this.flushOutputBuffer();
      return;
    }

    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.flushOutputBuffer();
      }, WorkerInstanceNotifier.OUTPUT_BATCH_INTERVAL_MS);
      if (this.outputFlushTimer.unref) {
        this.outputFlushTimer.unref();
      }
    }
  }

  sendHeartbeatNotification(instanceId: string): void {
    this.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.INSTANCE_HEARTBEAT,
      params: {
        instanceId,
        token: this.options.getToken()
      }
    });
  }

  sendCompleteNotification(instanceId: string, response: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.INSTANCE_COMPLETE,
      params: {
        instanceId,
        response,
        token: this.options.getToken()
      }
    });
  }

  sendContextNotification(instanceId: string, usage: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.INSTANCE_CONTEXT,
      params: {
        instanceId,
        usage,
        token: this.options.getToken()
      }
    });
  }

  sendStateChange(instanceId: string, state: unknown, info?: unknown): void {
    const seq = ++this.criticalSeq;
    this.sendCritical({
      jsonrpc: '2.0',
      id: `sc-${seq}`,
      method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
      params: {
        instanceId,
        state,
        ...(info !== undefined ? { info } : {}),
        seq,
        token: this.options.getToken()
      }
    });
  }

  sendExit(instanceId: string, info: unknown): void {
    const seq = ++this.criticalSeq;
    this.sendCritical({
      jsonrpc: '2.0',
      id: `exit-${seq}`,
      method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
      params: {
        instanceId,
        state: 'exited',
        info,
        seq,
        token: this.options.getToken()
      }
    });
  }

  sendPermissionRequest(instanceId: string, permission: unknown): void {
    const seq = ++this.criticalSeq;
    this.sendCritical({
      jsonrpc: '2.0',
      id: `perm-${seq}`,
      method: NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST,
      params: {
        instanceId,
        permission,
        seq,
        token: this.options.getToken()
      }
    });
  }

  flushOutputBuffer(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }

    if (this.outputBuffer.length === 0) return;

    const items = this.outputBuffer;
    this.outputBuffer = [];
    const token = this.options.getToken();

    if (items.length === 1) {
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
        params: {
          instanceId: items[0].instanceId,
          message: items[0].message,
          token
        }
      });
    } else {
      this.send({
        jsonrpc: '2.0',
        method: NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
        params: { items, token }
      });
    }
  }

  flushCriticalQueue(): void {
    const ws = this.options.getSocket();
    if (this.criticalMessageQueue.length === 0) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const queued = this.criticalMessageQueue;
    this.criticalMessageQueue = [];
    for (const msg of queued) {
      const serialized = this.serializeFrame(msg);
      if (serialized === null) {
        continue;
      }
      ws.send(serialized, (err) => {
        if (err) {
          console.warn(
            '[WorkerAgent] Failed to flush critical message, re-queuing',
            {
              method: msg.method,
              error: err.message
            }
          );
          this.enqueueCriticalMessage(msg);
        }
      });
    }
  }

  private enqueueCriticalMessage(msg: RpcMessage): void {
    const msgParams = msg.params as Record<string, unknown> | undefined;
    const msgInstanceId = msgParams?.['instanceId'];
    if (
      msg.method === NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE &&
      msgInstanceId
    ) {
      const idx = this.criticalMessageQueue.findIndex((queued) => {
        if (queued.method !== NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE) {
          return false;
        }
        const qp = queued.params as Record<string, unknown> | undefined;
        return qp?.['instanceId'] === msgInstanceId;
      });
      if (idx !== -1) {
        const superseded = this.criticalMessageQueue[idx];
        this.criticalMessageQueue.splice(idx, 1);
        console.debug('[WorkerAgent] Superseded older state-change in queue', {
          instanceId: msgInstanceId,
          oldState: (superseded.params as Record<string, unknown>)?.['state'],
          newState: msgParams['state']
        });
      }
    }

    if (
      this.criticalMessageQueue.length >= WorkerInstanceNotifier.CRITICAL_QUEUE_MAX_SIZE
    ) {
      const dropped = this.criticalMessageQueue.shift();
      console.warn(
        '[WorkerAgent] Critical queue full, dropped oldest message',
        {
          method: dropped?.method
        }
      );
    }
    this.criticalMessageQueue.push(msg);
  }
}
