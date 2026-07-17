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
import type { RpcRequest, RpcResponse, RpcNotification, RpcScope } from './worker-node-rpc';
import { getRemoteNodeConfig } from './remote-node-config';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { getRemoteAuthService } from '../auth/remote-auth';
import { WORKER_NODE_WS_MAX_PAYLOAD_BYTES } from './rpc-schemas';
import { getRemoteWorkerRepairTracker } from './remote-worker-repair-tracker';
import { ConnectionFlapDetector } from './connection-flap-detector';
import {
  WORK_DISPATCH_METHODS,
  isWorkerNodeWorkDispatchMethod,
  trustedPlatformFromParams,
  summarizeRpcParams,
  withConnectionAddress,
} from './worker-node-connection-helpers';
import { bindWorkerNodeRosterUpdates } from './worker-node-roster-updates';
import { ConnectionDisconnectLifecycle } from './connection-disconnect-lifecycle';

// Re-exported for existing importers (tests, dispatch classification callers).
export { isWorkerNodeWorkDispatchMethod };

const logger = getLogger('WorkerNodeConnection');

const RPC_TIMEOUT_MS = 30_000;

/** Sliding window + threshold for flap-storm detection (replaces per node). */
const FLAP_WINDOW_MS = 60_000;
const FLAP_THRESHOLD = 10;

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
  // Grace + parked-work disconnect windows (see connection-disconnect-lifecycle).
  private readonly disconnectLifecycle = new ConnectionDisconnectLifecycle({
    isNodeConnected: (nodeId) => this.isNodeConnected(nodeId),
    isDurableNode: (nodeId) =>
      (getWorkerNodeRegistry().getNode(nodeId)?.capabilities?.streamDurability ?? 0) >= 1,
    hasPendingWork: (nodeId) =>
      [...this.pending.values()].some((pending) => pending.nodeId === nodeId && pending.isWork),
    rejectPending: (nodeId, reason, filter) => this.rejectPendingForNode(nodeId, reason, filter),
    onTrueDisconnect: (nodeId) => {
      const node = getWorkerNodeRegistry().getNode(nodeId);
      logger.info('Node WebSocket disconnected', { node: node?.name ?? nodeId, nodeId });
      this.emit('node:ws-disconnected', nodeId);
    },
  });
  private readonly flapDetector = new ConnectionFlapDetector(FLAP_WINDOW_MS, FLAP_THRESHOLD);
  private requestCounter = 0;
  private stopRosterUpdates: (() => void) | null = null;

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

      wss.on('connection', (ws, request) => {
        this.handleConnection(ws, request.socket.remoteAddress);
      });
    });

    this.stopRosterUpdates = bindWorkerNodeRosterUpdates(getWorkerNodeRegistry());
  }

  stop(): void {
    this.stopRosterUpdates?.();
    this.stopRosterUpdates = null;

    if (!this.wss) return;

    // Cancel all pending RPC requests
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('Server shutting down'));
      this.pending.delete(id);
    }

    // Cancel any in-flight disconnect grace/parked timers and clear flap state.
    this.disconnectLifecycle.clearAll();
    this.flapDetector.clear();

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
  private rejectPendingForNode(
    nodeId: string,
    reason: string,
    filter: 'all' | 'non-work' | 'work' = 'all',
  ): void {
    for (const [id, pending] of this.pending) {
      if (pending.nodeId !== nodeId) continue;
      if (filter === 'non-work' && pending.isWork) continue;
      if (filter === 'work' && !pending.isWork) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(id);
      if (pending.isWork) {
        const nodeName = getWorkerNodeRegistry().getNode(nodeId)?.name ?? nodeId;
        logger.warn('Remote node: work aborted — node disconnected', {
          node: nodeName,
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

  /**
   * Returns false when the node is not connected (WS15 typed failure — callers
   * can react instead of the send silently vanishing). Write errors after a
   * successful handoff are still logged asynchronously.
   */
  sendNotification(nodeId: string, method: string, params?: unknown, scope?: RpcScope): boolean {
    const ws = this.nodeToSocket.get(nodeId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      logger.warn('sendNotification: node not connected — notification NOT delivered', { nodeId, method });
      return false;
    }

    const notification = createRpcNotification(method, params, undefined, scope);
    ws.send(JSON.stringify(notification), (err) => {
      if (err) {
        logger.error('sendNotification failed', err, { nodeId, method });
      }
    });
    return true;
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
      const nodeName = getWorkerNodeRegistry().getNode(nodeId)?.name ?? nodeId;
      logger.info('Disconnected node', { node: nodeName, nodeId, reason });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — WebSocket event handling
  // ---------------------------------------------------------------------------

  private handleConnection(ws: WebSocket, remoteAddress?: string): void {
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
        this.handleRegistration(ws, msg, remoteAddress, (registeredId) => {
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
      // Defensive depth against a flap storm: do NOT immediately deregister the
      // node or fail its in-flight RPCs. A flapping link (or a fast worker
      // reconnect) frequently re-registers within a couple seconds; the node's
      // CLIs keep running locally the whole time. Start a short grace window and
      // only treat this as a true disconnect if no re-registration arrives.
      this.disconnectLifecycle.beginGrace(nodeId);
    });

    ws.on('error', (err) => {
      logger.error('WebSocket error', err, { nodeId: nodeId ?? 'unregistered' });
    });
  }

  /**
   * Record a socket-replace/reconnect event for flap-storm detection. Emits a
   * single WARN (and a `node:flap-storm` event for the UI) on the rising edge of
   * a storm — never one line per cycle.
   */
  private recordFlap(nodeId: string, nodeName: string): void {
    const result = this.flapDetector.record(nodeId, Date.now());
    if (result.stormStarted) {
      logger.warn('Worker node connection flap storm detected', {
        node: nodeName,
        nodeId,
        replacesInWindow: result.countInWindow,
        windowMs: FLAP_WINDOW_MS,
      });
      this.emit('node:flap-storm', {
        nodeId,
        nodeName,
        replacesInWindow: result.countInWindow,
        windowMs: FLAP_WINDOW_MS,
      });
    }
  }

  private handleRegistration(
    ws: WebSocket,
    msg: unknown,
    remoteAddress: string | undefined,
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
      logger.warn('Node registration rejected', { node: name, nodeId: newNodeId, reason: auth.reason });
      return;
    }

    getRemoteWorkerRepairTracker().clear(newNodeId);

    // Re-registered within the disconnect grace window → continuous session.
    // Cancelling the grace timer keeps the node in the registry and preserves
    // its in-flight RPCs (they were never rejected), effectively re-binding them
    // to this new socket.
    const withinGrace = this.disconnectLifecycle.cancelOnReregister(newNodeId);
    if (withinGrace) {
      logger.info('Node re-registered within disconnect grace — treating as continuous session', {
        node: name,
        nodeId: newNodeId,
      });
    }

    // Replace any existing socket for this nodeId
    const existing = this.nodeToSocket.get(newNodeId);
    if (existing && existing !== ws) {
      logger.warn('Replacing existing socket for nodeId', { node: name, nodeId: newNodeId });
      this.socketToNode.delete(existing);
      existing.close(1001, 'Replaced by new connection');
      this.recordFlap(newNodeId, name);
    } else if (withinGrace) {
      // A re-register after the previous socket already closed is still a flap
      // cycle even though there was no live socket to replace — count it so a
      // fast register/close/register storm is detected.
      this.recordFlap(newNodeId, name);
    }

    this.nodeToSocket.set(newNodeId, ws);
    this.socketToNode.set(ws, newNodeId);
    onRegistered(newNodeId);

    logger.info('Node registered via WebSocket', { node: name, nodeId: newNodeId });
    this.emit('node:ws-connected', newNodeId);

    // Forward the registration to the RPC router so it registers the node
    // in the registry and starts health monitoring.
    const request = withConnectionAddress(msg as RpcRequest, remoteAddress);
    this.emit('rpc:request', newNodeId, request);
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
