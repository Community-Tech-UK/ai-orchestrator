import { getLogger } from '../logging/logger';
import { NODE_TO_COORDINATOR, createRpcResponse, createRpcError, RPC_ERROR_CODES } from './worker-node-rpc';
import { getWorkerNodeHealth } from './worker-node-health';
import { BROWSER_CDP_MAX_FRAME_BYTES, validateRpcParams, RPC_PARAM_SCHEMAS } from './rpc-schemas';
import type { WorkerNodeConnectionServer } from './worker-node-connection';
import type { WorkerNodeRegistry } from './worker-node-registry';
import type { RpcRequest, RpcNotification } from './worker-node-rpc';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';
import { getRemoteAuthService } from '../auth/remote-auth';
import {
  getRemoteBrowserExtensionBridge,
  type RemoteBrowserExtensionBridge,
} from '../browser-gateway/remote-extension-bridge';

const logger = getLogger('RpcEventRouter');

export class RpcEventRouter {
  private readonly connection: WorkerNodeConnectionServer;
  private readonly registry: WorkerNodeRegistry;
  private readonly browserExtensionBridge?: RemoteBrowserExtensionBridge;

  // Bound handler references so stop() can cleanly remove them
  private readonly onWsConnected: (nodeId: string) => void;
  private readonly onWsDisconnected: (nodeId: string) => void;
  private readonly onRpcRequest: (nodeId: string, request: RpcRequest) => void;
  private readonly onRpcNotification: (nodeId: string, notification: RpcNotification) => void;

  /** Methods handled as trusted notifications — skip per-message auth validation. */
  private readonly trustedNotificationMethods = new Set<string>([
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
    NODE_TO_COORDINATOR.INSTANCE_HEARTBEAT,
    NODE_TO_COORDINATOR.INSTANCE_COMPLETE,
    NODE_TO_COORDINATOR.INSTANCE_CONTEXT,
    // terminal.output is a high-frequency PTY stream; like instance.output it
    // rides an already-authenticated WS, so we skip per-frame token checks.
    NODE_TO_COORDINATOR.TERMINAL_OUTPUT,
    // browser.cdp.message is a high-frequency CDP frame stream (Path 2 remote
    // browser tunnel) — same rationale as terminal.output.
    NODE_TO_COORDINATOR.BROWSER_CDP_MESSAGE,
  ]);

  /**
   * Tracks the highest `seq` value received per node for critical messages
   * (state changes, permission requests). Messages with a seq ≤ the last-seen
   * value are stale (e.g. replayed from a reconnect queue after a fresher
   * message was already delivered) and are discarded.
   */
  private readonly lastSeenSeq = new Map<string, number>();

  constructor(
    connection: WorkerNodeConnectionServer,
    registry: WorkerNodeRegistry,
    browserExtensionBridge?: RemoteBrowserExtensionBridge,
  ) {
    this.connection = connection;
    this.registry = registry;
    this.browserExtensionBridge = browserExtensionBridge;

    this.onWsConnected = this.handleWsConnected.bind(this);
    this.onWsDisconnected = this.handleWsDisconnected.bind(this);
    this.onRpcRequest = (nodeId, request) => {
      void this.handleRpcRequest(nodeId, request);
    };
    this.onRpcNotification = this.handleRpcNotification.bind(this);
  }

  start(): void {
    this.connection.on('node:ws-connected', this.onWsConnected);
    this.connection.on('node:ws-disconnected', this.onWsDisconnected);
    this.connection.on('rpc:request', this.onRpcRequest);
    this.connection.on('rpc:notification', this.onRpcNotification);
  }

  stop(): void {
    this.connection.off('node:ws-connected', this.onWsConnected);
    this.connection.off('node:ws-disconnected', this.onWsDisconnected);
    this.connection.off('rpc:request', this.onRpcRequest);
    this.connection.off('rpc:notification', this.onRpcNotification);
  }

  // ---------------------------------------------------------------------------
  // WebSocket lifecycle handlers
  // ---------------------------------------------------------------------------

  private handleWsConnected(nodeId: string): void {
    logger.info('Node WebSocket connected — awaiting registration', { nodeId });
  }

  private handleWsDisconnected(nodeId: string): void {
    getWorkerNodeHealth().stopMonitoring(nodeId);
    this.lastSeenSeq.delete(nodeId);
    this.getBrowserExtensionBridge().expireNode(nodeId);
    if (this.registry.getNode(nodeId)) {
      this.registry.deregisterNode(nodeId);
    }
  }

  /**
   * Returns true if this message should be processed. Returns false (and logs)
   * if the message is stale — i.e. a lower or equal seq than one already seen
   * from this node. Messages without a seq field are always accepted (backwards
   * compatibility with older worker agents).
   */
  private acceptSeq(nodeId: string, params: Record<string, unknown> | undefined): boolean {
    const seq = typeof params?.['seq'] === 'number' ? params['seq'] : undefined;
    if (seq === undefined) return true; // no seq — accept unconditionally

    const last = this.lastSeenSeq.get(nodeId) ?? 0;
    if (seq <= last) {
      logger.debug('Discarding stale critical message', { nodeId, seq, lastSeen: last });
      return false;
    }
    this.lastSeenSeq.set(nodeId, seq);
    return true;
  }

  // ---------------------------------------------------------------------------
  // RPC request dispatcher
  // ---------------------------------------------------------------------------

  private async handleRpcRequest(nodeId: string, request: RpcRequest): Promise<void> {
    // node.register is authenticated during the initial WebSocket handshake.
    const params = request.params as Record<string, unknown> | undefined;
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (
      request.method !== NODE_TO_COORDINATOR.REGISTER
      && !getRemoteAuthService().validateSessionToken(token, nodeId)
    ) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.UNAUTHORIZED, 'Invalid auth token'),
      );
      return;
    }

    // Validate payload schema if one is defined for this method
    const schema = RPC_PARAM_SCHEMAS[request.method];
    if (schema) {
      try {
        validateRpcParams(schema, request.params);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Validation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INVALID_PARAMS, message),
        );
        return;
      }
    }

    try {
      switch (request.method) {
        case NODE_TO_COORDINATOR.REGISTER:
          this.handleNodeRegister(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.HEARTBEAT:
          this.handleNodeHeartbeat(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE:
          this.handleInstanceStateChange(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST:
          this.handleInstancePermissionRequest(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.BROWSER_EXT_ATTACH_TAB:
          await this.handleBrowserExtAttachTab(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.BROWSER_EXT_POLL_COMMAND:
          await this.handleBrowserExtPollCommand(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT:
          this.handleBrowserExtCommandResult(nodeId, request);
          break;
        default:
          logger.warn('Unknown RPC method received', { nodeId, method: request.method });
          this.connection.sendResponse(
            nodeId,
            createRpcError(
              request.id,
              RPC_ERROR_CODES.METHOD_NOT_FOUND,
              `Unknown RPC method: ${request.method}`,
            ),
          );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'RPC handler failed';
      logger.error('RPC request handler failed', err instanceof Error ? err : undefined, {
        nodeId,
        method: request.method,
      });
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // RPC notification dispatcher
  // ---------------------------------------------------------------------------

  private handleRpcNotification(nodeId: string, notification: RpcNotification): void {
    // Trusted notification methods skip per-message auth validation.
    // The WebSocket was authenticated during node.register.
    if (!this.trustedNotificationMethods.has(notification.method)) {
      const params = notification.params as Record<string, unknown> | undefined;
      const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
      if (!getRemoteAuthService().validateSessionToken(token, nodeId)) {
        logger.warn('Notification rejected: invalid auth token', { nodeId, method: notification.method });
        return;
      }
    }

    switch (notification.method) {
      case NODE_TO_COORDINATOR.HEARTBEAT: {
        const hbParams = notification.params as Record<string, unknown> | undefined;
        const node = this.registry.getNode(nodeId);
        if (!node) {
          logger.warn('Heartbeat notification received for unknown node', { nodeId });
          return;
        }
        this.registry.updateHeartbeat(nodeId, hbParams?.['capabilities'] as WorkerNodeCapabilities);
        this.recordTrustedPlatformFromCapabilities(nodeId, hbParams?.['capabilities'] as WorkerNodeCapabilities | undefined);
        this.registry.updateNodeMetrics(nodeId, {
          activeInstances: typeof hbParams?.['activeInstances'] === 'number'
            ? hbParams['activeInstances']
            : node.activeInstances,
        });
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT: {
        this.handleInstanceOutputNotification(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH: {
        this.handleInstanceOutputBatch(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_HEARTBEAT: {
        this.handleInstanceHeartbeat(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_COMPLETE: {
        this.handleInstanceComplete(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.INSTANCE_CONTEXT: {
        this.handleInstanceContext(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.TERMINAL_OUTPUT: {
        this.handleTerminalOutputNotification(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.TERMINAL_EXIT: {
        this.handleTerminalExitNotification(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.BROWSER_CDP_MESSAGE: {
        this.handleBrowserCdpMessageNotification(nodeId, notification);
        break;
      }
      case NODE_TO_COORDINATOR.BROWSER_CDP_CLOSED: {
        this.handleBrowserCdpClosedNotification(nodeId, notification);
        break;
      }
      default:
        logger.warn('Unknown RPC notification method received', { nodeId, method: notification.method });
    }
  }

  // ---------------------------------------------------------------------------
  // Individual request handlers
  // ---------------------------------------------------------------------------

  private handleNodeRegister(wsNodeId: string, request: RpcRequest): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;
    const nodeId = typeof params?.['nodeId'] === 'string' ? params['nodeId'] : wsNodeId;
    const name = typeof params?.['name'] === 'string' ? params['name'] : nodeId;
    const capabilities = params?.['capabilities'] as WorkerNodeCapabilities;

    this.registry.registerNode({
      id: nodeId,
      name,
      address: '',
      capabilities,
      status: 'connected',
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      activeInstances: 0,
    });

    getWorkerNodeHealth().startMonitoring(nodeId);

    logger.info('Node registered via RPC', { nodeId, name });
  }

  private handleNodeHeartbeat(nodeId: string, request: RpcRequest): void {
    const node = this.registry.getNode(nodeId);
    if (!node) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }

    const params = request.params as Record<string, unknown> | undefined;
    const capabilities = params?.['capabilities'] as WorkerNodeCapabilities;
    this.registry.updateHeartbeat(nodeId, capabilities);
    this.recordTrustedPlatformFromCapabilities(nodeId, capabilities);
    this.registry.updateNodeMetrics(nodeId, {
      activeInstances: typeof params?.['activeInstances'] === 'number'
        ? params['activeInstances']
        : node.activeInstances,
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private handleInstanceOutputNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Output notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    this.registry.emit('remote:instance-output', {
      nodeId,
      instanceId: params?.['instanceId'],
      message: params?.['message'],
    });
  }

  private handleInstanceOutputBatch(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Output batch notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const items = params?.['items'];
    if (!Array.isArray(items)) {
      logger.warn('Output batch missing items array', { nodeId });
      return;
    }
    for (const item of items) {
      const entry = item as Record<string, unknown>;
      this.registry.emit('remote:instance-output', {
        nodeId,
        instanceId: entry['instanceId'],
        message: entry['message'],
      });
    }
  }

  private handleInstanceHeartbeat(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Heartbeat notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    this.registry.emit('remote:instance-heartbeat', {
      nodeId,
      instanceId: params?.['instanceId'],
    });
  }

  private handleInstanceComplete(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Complete notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    this.registry.emit('remote:instance-complete', {
      nodeId,
      instanceId: params?.['instanceId'],
      response: params?.['response'],
    });
  }

  private handleInstanceContext(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Context notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    this.registry.emit('remote:instance-context', {
      nodeId,
      instanceId: params?.['instanceId'],
      usage: params?.['usage'],
    });
  }

  private handleTerminalOutputNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Terminal output notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const sessionId = params?.['sessionId'];
    const data = params?.['data'];
    if (typeof sessionId !== 'string' || typeof data !== 'string') {
      logger.warn('Malformed terminal.output notification', { nodeId });
      return;
    }
    this.registry.emit('remote:terminal-output', { nodeId, sessionId, data });
  }

  private handleTerminalExitNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Terminal exit notification from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const sessionId = params?.['sessionId'];
    if (typeof sessionId !== 'string') {
      logger.warn('Malformed terminal.exit notification', { nodeId });
      return;
    }
    const exitCode = typeof params?.['exitCode'] === 'number' ? (params['exitCode'] as number) : null;
    const signal = typeof params?.['signal'] === 'string' ? (params['signal'] as string) : null;
    this.registry.emit('remote:terminal-exit', { nodeId, sessionId, exitCode, signal });
  }

  private handleBrowserCdpMessageNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Browser CDP message from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const sessionId = params?.['sessionId'];
    const frame = params?.['frame'];
    if (typeof sessionId !== 'string' || typeof frame !== 'string') {
      logger.warn('Malformed browser.cdp.message notification', { nodeId });
      return;
    }
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    if (frameBytes > BROWSER_CDP_MAX_FRAME_BYTES) {
      logger.warn('Oversized browser.cdp.message notification dropped', {
        nodeId,
        sessionId,
        frameBytes,
        maxFrameBytes: BROWSER_CDP_MAX_FRAME_BYTES,
      });
      return;
    }
    this.registry.emit('remote:browser-cdp-message', { nodeId, sessionId, frame });
  }

  private handleBrowserCdpClosedNotification(nodeId: string, notification: RpcNotification): void {
    if (!this.registry.getNode(nodeId)) {
      logger.warn('Browser CDP closed from unknown node', { nodeId });
      return;
    }
    const params = notification.params as Record<string, unknown> | undefined;
    const sessionId = params?.['sessionId'];
    if (typeof sessionId !== 'string') {
      logger.warn('Malformed browser.cdp.closed notification', { nodeId });
      return;
    }
    this.registry.emit('remote:browser-cdp-closed', { nodeId, sessionId });
  }

  private handleInstanceStateChange(nodeId: string, request: RpcRequest): void {
    if (!this.registry.getNode(nodeId)) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;

    // Discard stale state changes that arrive out-of-order after reconnection
    if (!this.acceptSeq(nodeId, params)) {
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true, stale: true }));
      return;
    }

    this.registry.emit('remote:instance-state-change', {
      nodeId,
      instanceId: params?.['instanceId'],
      state: params?.['state'],
      info: params?.['info'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private handleInstancePermissionRequest(nodeId: string, request: RpcRequest): void {
    if (!this.registry.getNode(nodeId)) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;

    // Discard stale permission requests that arrive out-of-order after reconnection
    if (!this.acceptSeq(nodeId, params)) {
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true, stale: true }));
      return;
    }

    this.registry.emit('remote:instance-permission-request', {
      nodeId,
      instanceId: params?.['instanceId'],
      permission: params?.['permission'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private async handleBrowserExtAttachTab(nodeId: string, request: RpcRequest): Promise<void> {
    const result = await this.getBrowserExtensionBridge().attachTab(
      nodeId,
      request.params as never,
    );
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
  }

  private async handleBrowserExtPollCommand(nodeId: string, request: RpcRequest): Promise<void> {
    const result = await this.getBrowserExtensionBridge().pollCommand(
      nodeId,
      request.params as never,
    );
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
  }

  private handleBrowserExtCommandResult(nodeId: string, request: RpcRequest): void {
    const result = this.getBrowserExtensionBridge().commandResult(
      nodeId,
      request.params as never,
    );
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
  }

  private getBrowserExtensionBridge(): RemoteBrowserExtensionBridge {
    return this.browserExtensionBridge ?? getRemoteBrowserExtensionBridge();
  }

  private recordTrustedPlatformFromCapabilities(
    nodeId: string,
    capabilities: WorkerNodeCapabilities | undefined,
  ): void {
    if (!isKnownPlatform(capabilities?.platform)) {
      return;
    }
    try {
      getRemoteAuthService().recordTrustedPlatform(nodeId, capabilities.platform);
    } catch (err) {
      logger.warn('Failed to persist trusted worker platform snapshot', {
        nodeId,
        platform: capabilities.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

}

function isKnownPlatform(platform: unknown): platform is WorkerNodeCapabilities['platform'] {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}
