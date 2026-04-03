import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { reportCapabilities } from './capability-reporter';
import { LocalInstanceManager, type SpawnParams } from './local-instance-manager';
import type { WorkerConfig } from './worker-config';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Worker node agent — connects to coordinator, handles RPC commands,
 * manages local CLI instances, sends heartbeats.
 */
export class WorkerAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly instanceManager: LocalInstanceManager;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private capabilities: WorkerNodeCapabilities | null = null;
  private isShuttingDown = false;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances,
    );
    this.wireInstanceEvents();
  }

  async connect(): Promise<void> {
    this.isShuttingDown = false;
    this.capabilities = await reportCapabilities(
      this.config.workingDirectories,
      this.config.maxConcurrentInstances,
    );

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.coordinatorUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.sendRegistration();
        this.startHeartbeat();
        resolve();
      });

      ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        this.ws = null;
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!this.ws) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.instanceManager.terminateAll();
    if (this.ws) {
      this.ws.close(1000, 'Worker shutting down');
      this.ws = null;
    }
  }

  // -- Registration & heartbeat -----------------------------------------------

  /** Exposed for testing. */
  buildRegistrationMessage(): RpcMessage {
    return {
      jsonrpc: '2.0',
      id: `reg-${Date.now()}`,
      method: 'node.register',
      params: {
        nodeId: this.config.nodeId,
        name: this.config.name,
        capabilities: this.capabilities,
        token: this.config.authToken,
      },
    };
  }

  private sendRegistration(): void {
    this.send(this.buildRegistrationMessage());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      // Refresh capabilities (memory changes over time)
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances,
      );
      this.send({
        jsonrpc: '2.0',
        method: 'node.heartbeat',
        params: {
          nodeId: this.config.nodeId,
          capabilities: this.capabilities,
          activeInstances: this.instanceManager.getInstanceCount(),
          token: this.config.authToken,
        },
      });
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    console.log(`Connection lost. Reconnecting in ${this.config.reconnectIntervalMs}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        console.log('Reconnected to coordinator');
      } catch {
        // connect() failed — close handler will schedule next retry
      }
    }, this.config.reconnectIntervalMs);
  }

  // -- Message handling -------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      console.error('Invalid JSON from coordinator:', raw.slice(0, 200));
      return;
    }

    // Response to one of our requests
    if (msg.result !== undefined || msg.error !== undefined) {
      return; // Responses are informational for now
    }

    // RPC request from coordinator
    if (msg.method && msg.id !== undefined) {
      this.handleRpcRequest(msg);
    }
  }

  private async handleRpcRequest(msg: RpcMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (msg.method) {
        case 'instance.spawn':
          await this.instanceManager.spawn(params as unknown as SpawnParams);
          result = { instanceId: params['instanceId'] };
          break;
        case 'instance.sendInput':
          await this.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
          );
          result = { ok: true };
          break;
        case 'instance.terminate':
          await this.instanceManager.terminate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case 'instance.interrupt':
          await this.instanceManager.interrupt(params['instanceId'] as string);
          result = { ok: true };
          break;
        case 'node.ping':
          result = { pong: Date.now() };
          break;
        default:
          this.sendError(msg.id!, -32601, `Unknown method: ${msg.method}`);
          return;
      }
      this.sendResult(msg.id!, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg.id!, -32603, message);
    }
  }

  // -- Instance event forwarding ----------------------------------------------

  private wireInstanceEvents(): void {
    this.instanceManager.on('instance:output', (instanceId: string, message: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.output',
        params: { instanceId, message, token: this.config.authToken },
      });
    });

    this.instanceManager.on('instance:stateChange', (instanceId: string, state: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.stateChange',
        params: { instanceId, state, token: this.config.authToken },
      });
    });

    this.instanceManager.on('instance:exit', (instanceId: string, info: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `exit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.stateChange',
        params: { instanceId, state: 'exited', info, token: this.config.authToken },
      });
    });
  }

  // -- Transport helpers ------------------------------------------------------

  private send(msg: RpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) console.error('Send error:', err.message);
      });
    }
  }

  private sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result } as RpcMessage);
  }

  private sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } as RpcMessage);
  }
}
