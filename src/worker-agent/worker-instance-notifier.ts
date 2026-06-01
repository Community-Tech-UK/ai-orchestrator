import { WebSocket } from 'ws';
import {
  NODE_TO_COORDINATOR,
} from '../main/remote-node/worker-node-rpc';
import type { RpcMessage } from './worker-rpc-types';

interface WorkerInstanceNotifierOptions {
  getSocket: () => WebSocket | null;
  getToken: () => string | undefined;
}

export class WorkerInstanceNotifier {
  private outputBuffer: { instanceId: string; message: unknown }[] = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private criticalMessageQueue: RpcMessage[] = [];
  private criticalSeq = 0;

  private static readonly OUTPUT_BATCH_INTERVAL_MS = 50;
  private static readonly OUTPUT_BATCH_MAX_SIZE = 10;
  private static readonly CRITICAL_QUEUE_MAX_SIZE = 100;

  constructor(private readonly options: WorkerInstanceNotifierOptions) {}

  send(msg: RpcMessage): void {
    const ws = this.options.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      this.flushCriticalQueue();
      ws.send(JSON.stringify(msg), (err) => {
        if (err) console.error('Send error:', err.message);
      });
    } else {
      console.warn('[WorkerAgent] Message dropped — WebSocket not open', {
        method: msg.method,
        readyState: ws?.readyState
      });
    }
  }

  sendCritical(msg: RpcMessage): void {
    const ws = this.options.getSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      this.flushCriticalQueue();
      ws.send(JSON.stringify(msg), (err) => {
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
    this.outputBuffer.push({ instanceId, message });

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

  sendStateChange(instanceId: string, state: unknown): void {
    const seq = ++this.criticalSeq;
    this.sendCritical({
      jsonrpc: '2.0',
      id: `sc-${seq}`,
      method: NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE,
      params: {
        instanceId,
        state,
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
      ws.send(JSON.stringify(msg), (err) => {
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
