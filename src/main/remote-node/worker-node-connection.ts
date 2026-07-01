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
  COORDINATOR_TO_NODE,
} from './worker-node-rpc';
import type { RpcRequest, RpcResponse, RpcNotification, RpcScope } from './worker-node-rpc';
import { getRemoteNodeConfig } from './remote-node-config';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { NodePlatform, WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getRemoteAuthService } from '../auth/remote-auth';
import { WORKER_NODE_WS_MAX_PAYLOAD_BYTES } from './rpc-schemas';
import { getRemoteWorkerRepairTracker } from './remote-worker-repair-tracker';

const logger = getLogger('WorkerNodeConnection');

const RPC_TIMEOUT_MS = 30_000;

/**
 * RPC methods that represent the coordinator actually *using* a remote node
 * (the "slave machine") to do real work — spawning/driving agents, offloading
 * auxiliary-LLM generation to the node's local model server, or opening a
 * remote terminal. These are logged at `info` so it's visible at a glance
 * whether offload is genuinely happening. Everything else (health pings,
 * filesystem reads, sync, terminal keystrokes) is routine and logged at
 * `debug` to keep the signal clean.
 */
const WORK_DISPATCH_METHODS = new Set<string>([
  COORDINATOR_TO_NODE.INSTANCE_SPAWN,
  COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT,
  COORDINATOR_TO_NODE.INSTANCE_INTERRUPT,
  COORDINATOR_TO_NODE.INSTANCE_TERMINATE,
  COORDINATOR_TO_NODE.INSTANCE_HIBERNATE,
  COORDINATOR_TO_NODE.INSTANCE_WAKE,
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE,
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_LIST,
  COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE,
  COORDINATOR_TO_NODE.TERMINAL_CREATE,
]);

export function isWorkerNodeWorkDispatchMethod(method: string): boolean {
  return WORK_DISPATCH_METHODS.has(method);
}

function trustedPlatformFromParams(params: Record<string, unknown> | undefined): NodePlatform | undefined {
  const capabilities = params?.['capabilities'];
  if (!capabilities || typeof capabilities !== 'object') {
    return undefined;
  }
  const platform = (capabilities as Record<string, unknown>)['platform'];
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : undefined;
}

/**
 * Extract only safe, non-sensitive scalar fields from RPC params for logging.
 * Deliberately omits prompt/input/content/token fields so agent prompts and
 * secrets never reach the logs.
 */
function summarizeRpcParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'instanceId',
    'provider',
    'model',
    'slot',
    'cliType',
    'cwd',
    'workingDirectory',
    'terminalId',
  ]) {
    const value = p[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  nodeId: string;
  method: string;
  startedAt: number;
  isWork: boolean;
}

export class WorkerNodeConnectionServer extends EventEmitter {
  private static instance: WorkerNodeConnectionServer;

  private wss: WebSocketServer | null = null;
  private readonly nodeToSocket = new Map<string, WebSocket>();
  private readonly socketToNode = new Map<WebSocket, string>();
  private readonly pending = new Map<string | number, PendingRpc>();
  private requestCounter = 0;
  private broadcastAll: (() => void) | null = null;

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

        wss = new WebSocketServer({ server, maxPayload: WORKER_NODE_WS_MAX_PAYLOAD_BYTES });

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
        wss = new WebSocketServer({ host, port, maxPayload: WORKER_NODE_WS_MAX_PAYLOAD_BYTES });

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

    const registry = getWorkerNodeRegistry();
    this.broadcastAll = () => this.broadcastNodesToRenderer(registry.getAllNodes());
    registry.on('node:connected', this.broadcastAll);
    registry.on('node:disconnected', this.broadcastAll);
    registry.on('node:updated', this.broadcastAll);
  }

  stop(): void {
    if (this.broadcastAll) {
      const registry = getWorkerNodeRegistry();
      registry.removeListener('node:connected', this.broadcastAll);
      registry.removeListener('node:disconnected', this.broadcastAll);
      registry.removeListener('node:updated', this.broadcastAll);
      this.broadcastAll = null;
    }

    if (!this.wss) return;

    // Cancel all pending RPC requests
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
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

  isRunning(): boolean {
    return this.wss !== null;
  }

  broadcastNodesToRenderer(nodes: WorkerNodeInfo[]): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { BrowserWindow } = require('electron');
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, nodes);
      }
    } catch {
      // Not in Electron context (e.g., tests)
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound — coordinator to node
  // ---------------------------------------------------------------------------

  async sendRpc<T>(
    nodeId: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    scope?: RpcScope,
  ): Promise<T> {
    const id = `coord-${++this.requestCounter}`;
    const request = createRpcRequest(id, method, params, undefined, scope);
    const timeout = timeoutMs ?? RPC_TIMEOUT_MS;
    const isWork = WORK_DISPATCH_METHODS.has(method);
    const startedAt = Date.now();
    const nodeName = getWorkerNodeRegistry().getNode(nodeId)?.name ?? nodeId;

    if (isWork) {
      const summary = summarizeRpcParams(params);
      logger.info('Remote node: dispatching work', {
        node: nodeName,
        nodeId,
        method,
        requestId: id,
        ...(summary ?? {}),
      });
    } else {
      logger.debug('Remote node: sending RPC', { node: nodeName, nodeId, method, requestId: id });
    }
    // A non-positive timeout disables the timer entirely. Required for RPCs
    // whose worker-side handler blocks for an unbounded duration — notably
    // `instance.sendInput`, where the Codex app-server adapter stays inside
    // sendInput() for the ENTIRE turn. A fixed timeout would falsely fail any
    // turn longer than it, even while output streams back over notifications.
    // Such requests are instead bounded by node disconnect (rejectPendingForNode)
    // and the coordinator's own stuck-process watchdog.
    const timeoutDisabled = timeout <= 0;

    return new Promise<T>((resolve, reject) => {
      // Register pending RPC and start timeout BEFORE checking socket state.
      // This avoids a TOCTOU race where the socket closes between the check
      // and the send() call — the timeout handles cleanup either way.
      const timer = timeoutDisabled
        ? null
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`RPC timeout after ${timeout}ms: ${method} (id=${id})`));
          }, timeout);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        nodeId,
        method,
        startedAt,
        isWork,
      });

      const ws = this.nodeToSocket.get(nodeId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        if (isWork) {
          logger.warn('Remote node: work dispatch failed — node not connected', {
            node: nodeName,
            nodeId,
            method,
            requestId: id,
          });
        }
        reject(new Error(`Node not connected: ${nodeId}`));
        return;
      }

      ws.send(JSON.stringify(request), (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Reject every pending RPC awaiting a response from the given node. Called
   * when a node's WebSocket truly disconnects so that in-flight requests fail
   * promptly instead of hanging until their (possibly disabled) timeout.
   */
  private rejectPendingForNode(nodeId: string, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.nodeId !== nodeId) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      if (pending.isWork) {
        logger.warn('Remote node: work aborted — node disconnected', {
          nodeId,
          method: pending.method,
          requestId: id,
          latencyMs: Date.now() - pending.startedAt,
          reason,
        });
      }
      pending.reject(new Error(reason));
    }
  }

  sendNotification(nodeId: string, method: string, params?: unknown, scope?: RpcScope): void {
    const ws = this.nodeToSocket.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('sendNotification: node not connected', { nodeId, method });
      return;
    }

    const notification = createRpcNotification(method, params, undefined, scope);
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

  disconnectNode(nodeId: string, reason = 'Node revoked'): void {
    const ws = this.nodeToSocket.get(nodeId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(1008, reason);
      logger.info('Disconnected node', { nodeId, reason });
    }
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
      if (nodeId === null) {
        return;
      }
      // Only treat this close as a true disconnect if this socket is still the
      // active one for the node. When a worker reconnects, the new socket
      // replaces the old in nodeToSocket *before* the old socket's close event
      // fires. Without this guard, the stale socket's close would delete the new
      // socket's mapping and emit node:ws-disconnected, deregistering a node
      // that just successfully re-registered — leaving a live, heartbeating
      // worker permanently absent from the registry ("unknown node" heartbeats).
      if (this.nodeToSocket.get(nodeId) !== ws) {
        this.socketToNode.delete(ws);
        logger.info('Replaced worker socket closed; keeping active connection', { nodeId });
        return;
      }
      this.nodeToSocket.delete(nodeId);
      this.socketToNode.delete(ws);
      // Fail any in-flight RPCs to this node now, rather than letting them hang
      // until their timeout (or forever, for timeout-disabled requests such as
      // instance.sendInput).
      this.rejectPendingForNode(nodeId, `Node disconnected: ${nodeId}`);
      logger.info('Node WebSocket disconnected', { nodeId });
      this.emit('node:ws-disconnected', nodeId);
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

    // Authenticate registration via session token or pairing token exchange.
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    const recoveryToken = typeof params?.['recoveryToken'] === 'string' ? params['recoveryToken'] : undefined;
    const name = typeof params?.['name'] === 'string' ? params['name'] : newNodeId;
    const platform = trustedPlatformFromParams(params);
    const auth = getRemoteAuthService().authenticateRegistration({
      nodeId: newNodeId,
      nodeName: name,
      token,
      recoveryToken,
      platform,
    });
    if (auth.status === 'rejected') {
      getRemoteWorkerRepairTracker().recordRejectedRegistration({
        nodeId: newNodeId,
        nodeName: name,
        platformHint: platform,
        reason: auth.reason,
      });
      const errorResponse = createRpcError(
        msg.id,
        RPC_ERROR_CODES.UNAUTHORIZED,
        auth.reason,
      );
      ws.send(JSON.stringify(errorResponse));
      ws.close(4001, 'Unauthorized');
      logger.warn('Node registration rejected', { nodeId: newNodeId, reason: auth.reason });
      return;
    }

    getRemoteWorkerRepairTracker().clear(newNodeId);

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

    // Forward the registration to the RPC router so it registers the node
    // in the registry and starts health monitoring.
    this.emit('rpc:request', newNodeId, msg as RpcRequest);
    this.sendResponse(newNodeId, {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: auth.session.sessionId,
        nodeId: auth.session.nodeId,
        token: auth.session.token,
        recoveryToken: auth.session.recoveryToken,
      },
    });
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

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(response.id);

    if (pending.isWork) {
      const latencyMs = Date.now() - pending.startedAt;
      const nodeName = getWorkerNodeRegistry().getNode(pending.nodeId)?.name ?? pending.nodeId;
      if (response.error) {
        logger.warn('Remote node: work failed', {
          node: nodeName,
          nodeId: pending.nodeId,
          method: pending.method,
          requestId: response.id,
          latencyMs,
          error: `${response.error.code}: ${response.error.message}`,
        });
      } else {
        logger.info('Remote node: work completed', {
          node: nodeName,
          nodeId: pending.nodeId,
          method: pending.method,
          requestId: response.id,
          latencyMs,
        });
      }
    }

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
