import { EventEmitter } from 'events';
import * as https from 'https';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { getLogger } from '../logging/logger';
import {
  createRpcRequest,
  createRpcError,
  createRpcNotification,
  isRpcRequest,
  isRpcResponse,
  isRpcNotification,
  RPC_ERROR_CODES,
} from './worker-node-rpc';
import type { RpcRequest, RpcResponse, RpcNotification } from './worker-node-rpc';
import { getRemoteNodeConfig } from './remote-node-config';
import { validateAuthToken } from './auth-validator';

const logger = getLogger('WorkerNodeConnection');

const RPC_TIMEOUT_MS = 30_000;

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WorkerNodeConnectionServer extends EventEmitter {
  private static instance: WorkerNodeConnectionServer;

  private wss: WebSocketServer | null = null;
  private readonly nodeToSocket = new Map<string, WebSocket>();
  private readonly socketToNode = new Map<WebSocket, string>();
  private readonly pending = new Map<string | number, PendingRpc>();
  private requestCounter = 0;

  static getInstance(): WorkerNodeConnectionServer {
    if (!this.instance) {
      this.instance = new WorkerNodeConnectionServer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stop();
      (this.instance as unknown) = undefined;
    }
  }

  private constructor() {
    super();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.wss) {
      logger.warn('WorkerNodeConnectionServer already running');
      return;
    }

    const config = getRemoteNodeConfig();
    const useTls = config.tlsCertPath && config.tlsKeyPath;

    await new Promise<void>((resolve, reject) => {
      let wss: WebSocketServer;

      if (useTls) {
        const server = https.createServer({
          cert: fs.readFileSync(config.tlsCertPath!),
          key: fs.readFileSync(config.tlsKeyPath!),
          ...(config.tlsCaPath ? { ca: fs.readFileSync(config.tlsCaPath), requestCert: true, rejectUnauthorized: true } : {}),
        });

        wss = new WebSocketServer({ server });

        server.on('error', (err) => {
          if (!this.wss) reject(err);
          else logger.error('HTTPS server error', err);
        });

        server.listen(port, host, () => {
          this.wss = wss;
          logger.info('WorkerNodeConnectionServer listening (WSS/TLS)', { host, port });
          resolve();
        });
      } else {
        wss = new WebSocketServer({ host, port });

        wss.on('error', (err) => {
          if (!this.wss) reject(err);
          else logger.error('WebSocket server error', err);
        });

        wss.on('listening', () => {
          this.wss = wss;
          logger.info('WorkerNodeConnectionServer listening', { host, port });
          resolve();
        });
      }

      wss.on('connection', (ws) => {
        this.handleConnection(ws);
      });
    });
  }

  stop(): void {
    if (!this.wss) return;

    // Cancel all pending RPC requests
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
      this.pending.delete(id);
    }

    // Close all WebSocket connections
    for (const ws of this.nodeToSocket.values()) {
      ws.close(1001, 'Server shutting down');
    }

    this.nodeToSocket.clear();
    this.socketToNode.clear();

    this.wss.close((err) => {
      if (err) {
        logger.error('Error closing WebSocket server', err);
      } else {
        logger.info('WorkerNodeConnectionServer stopped');
      }
    });
    this.wss = null;
  }

  // ---------------------------------------------------------------------------
  // Outbound — coordinator to node
  // ---------------------------------------------------------------------------

  async sendRpc<T>(nodeId: string, method: string, params?: unknown): Promise<T> {
    const ws = this.nodeToSocket.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Node not connected: ${nodeId}`);
    }

    const id = `coord-${++this.requestCounter}`;
    const request = createRpcRequest(id, method, params);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms: ${method} (id=${id})`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      ws.send(JSON.stringify(request), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  sendNotification(nodeId: string, method: string, params?: unknown): void {
    const ws = this.nodeToSocket.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('sendNotification: node not connected', { nodeId, method });
      return;
    }

    const notification = createRpcNotification(method, params);
    ws.send(JSON.stringify(notification), (err) => {
      if (err) {
        logger.error('sendNotification failed', err, { nodeId, method });
      }
    });
  }

  broadcast(method: string, params?: unknown): void {
    const notification = createRpcNotification(method, params);
    const raw = JSON.stringify(notification);

    for (const [nodeId, ws] of this.nodeToSocket) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(raw, (err) => {
        if (err) {
          logger.error('broadcast send failed', err, { nodeId, method });
        }
      });
    }
  }

  sendResponse(nodeId: string, response: RpcResponse): void {
    const ws = this.nodeToSocket.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('sendResponse: node not connected', { nodeId });
      return;
    }

    ws.send(JSON.stringify(response), (err) => {
      if (err) {
        logger.error('sendResponse failed', err, { nodeId });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  isNodeConnected(nodeId: string): boolean {
    const ws = this.nodeToSocket.get(nodeId);
    return ws !== undefined && ws.readyState === WebSocket.OPEN;
  }

  getConnectedNodeIds(): string[] {
    return [...this.nodeToSocket.keys()].filter((nodeId) => this.isNodeConnected(nodeId));
  }

  // ---------------------------------------------------------------------------
  // Internal — WebSocket event handling
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    let nodeId: string | null = null;

    ws.on('message', (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        logger.warn('Received non-JSON message from unregistered socket');
        return;
      }

      if (nodeId === null) {
        // First message must be node.register
        this.handleRegistration(ws, msg, (registeredId) => {
          nodeId = registeredId;
        });
        return;
      }

      this.handleMessage(nodeId, msg);
    });

    ws.on('close', () => {
      if (nodeId !== null) {
        this.nodeToSocket.delete(nodeId);
        this.socketToNode.delete(ws);
        logger.info('Node WebSocket disconnected', { nodeId });
        this.emit('node:ws-disconnected', nodeId);
      }
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', err, { nodeId: nodeId ?? 'unregistered' });
    });
  }

  private handleRegistration(
    ws: WebSocket,
    msg: unknown,
    onRegistered: (nodeId: string) => void,
  ): void {
    if (!isRpcRequest(msg) || msg.method !== 'node.register') {
      logger.warn('First message is not node.register — closing socket');
      if (isRpcRequest(msg)) {
        const errorResponse = createRpcError(
          msg.id,
          RPC_ERROR_CODES.UNAUTHORIZED,
          'First message must be node.register',
        );
        ws.send(JSON.stringify(errorResponse));
      }
      ws.close(1008, 'Registration required');
      return;
    }

    const params = msg.params as Record<string, unknown> | undefined;
    const newNodeId = typeof params?.['nodeId'] === 'string' ? params['nodeId'] : null;

    if (!newNodeId) {
      const errorResponse = createRpcError(
        msg.id,
        RPC_ERROR_CODES.INVALID_PARAMS,
        'node.register requires params.nodeId',
      );
      ws.send(JSON.stringify(errorResponse));
      ws.close(1008, 'Missing nodeId');
      return;
    }

    // Validate auth token
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
      const errorResponse = createRpcError(
        msg.id,
        RPC_ERROR_CODES.UNAUTHORIZED,
        'Invalid or missing auth token',
      );
      ws.send(JSON.stringify(errorResponse));
      ws.close(4001, 'Unauthorized');
      logger.warn('Node registration rejected: invalid auth token', { nodeId: newNodeId });
      return;
    }

    // Replace any existing socket for this nodeId
    const existing = this.nodeToSocket.get(newNodeId);
    if (existing && existing !== ws) {
      logger.warn('Replacing existing socket for nodeId', { nodeId: newNodeId });
      this.socketToNode.delete(existing);
      existing.close(1001, 'Replaced by new connection');
    }

    this.nodeToSocket.set(newNodeId, ws);
    this.socketToNode.set(ws, newNodeId);
    onRegistered(newNodeId);

    logger.info('Node registered via WebSocket', { nodeId: newNodeId });
    this.emit('node:ws-connected', newNodeId);

    // Send success response
    const successResponse: RpcResponse = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { nodeId: newNodeId },
    };
    ws.send(JSON.stringify(successResponse));
  }

  private handleMessage(nodeId: string, msg: unknown): void {
    if (isRpcResponse(msg)) {
      this.handleRpcResponse(msg);
      return;
    }

    if (isRpcRequest(msg)) {
      this.emit('rpc:request', nodeId, msg as RpcRequest);
      return;
    }

    if (isRpcNotification(msg)) {
      this.emit('rpc:notification', nodeId, msg as RpcNotification);
      return;
    }

    logger.warn('Received unrecognised message from node', { nodeId, msg });
  }

  private handleRpcResponse(response: RpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      logger.warn('Received RPC response for unknown request id', { id: response.id });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(
        new Error(`RPC error ${response.error.code}: ${response.error.message}`),
      );
    } else {
      pending.resolve(response.result);
    }
  }
}

export function getWorkerNodeConnectionServer(): WorkerNodeConnectionServer {
  return WorkerNodeConnectionServer.getInstance();
}
