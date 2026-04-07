import { getLogger } from '../logging/logger';
import { NODE_TO_COORDINATOR, COORDINATOR_TO_NODE, createRpcResponse, createRpcError, RPC_ERROR_CODES } from './worker-node-rpc';
import { getWorkerNodeHealth } from './worker-node-health';
import { validateAuthToken } from './auth-validator';
import { validateRpcParams, RPC_PARAM_SCHEMAS } from './rpc-schemas';
import { NodeFilesystemHandler, FsRpcError } from './node-filesystem-handler';
import type { WorkerNodeConnectionServer } from './worker-node-connection';
import type { WorkerNodeRegistry } from './worker-node-registry';
import type { RpcRequest, RpcNotification } from './worker-node-rpc';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';

const logger = getLogger('RpcEventRouter');

export class RpcEventRouter {
  private readonly connection: WorkerNodeConnectionServer;
  private readonly registry: WorkerNodeRegistry;
  private readonly fsHandlers = new Map<string, NodeFilesystemHandler>();

  // Bound handler references so stop() can cleanly remove them
  private readonly onWsConnected: (nodeId: string) => void;
  private readonly onWsDisconnected: (nodeId: string) => void;
  private readonly onRpcRequest: (nodeId: string, request: RpcRequest) => void;
  private readonly onRpcNotification: (nodeId: string, notification: RpcNotification) => void;

  constructor(connection: WorkerNodeConnectionServer, registry: WorkerNodeRegistry) {
    this.connection = connection;
    this.registry = registry;

    this.onWsConnected = this.handleWsConnected.bind(this);
    this.onWsDisconnected = this.handleWsDisconnected.bind(this);
    this.onRpcRequest = this.handleRpcRequest.bind(this);
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
    if (this.registry.getNode(nodeId)) {
      this.registry.deregisterNode(nodeId);
    }
    const handler = this.fsHandlers.get(nodeId);
    if (handler) {
      handler.cleanupAllWatchers();
      this.fsHandlers.delete(nodeId);
    }
  }

  // ---------------------------------------------------------------------------
  // RPC request dispatcher
  // ---------------------------------------------------------------------------

  private handleRpcRequest(nodeId: string, request: RpcRequest): void {
    // Auth: validate token on every request
    const params = request.params as Record<string, unknown> | undefined;
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
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
        case NODE_TO_COORDINATOR.INSTANCE_OUTPUT:
          this.handleInstanceOutput(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE:
          this.handleInstanceStateChange(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST:
          this.handleInstancePermissionRequest(nodeId, request);
          break;
        case COORDINATOR_TO_NODE.FS_READ_DIRECTORY:
          void this.handleFsReadDirectory(nodeId, request);
          break;
        case COORDINATOR_TO_NODE.FS_STAT:
          void this.handleFsStat(nodeId, request);
          break;
        case COORDINATOR_TO_NODE.FS_SEARCH:
          void this.handleFsSearch(nodeId, request);
          break;
        case COORDINATOR_TO_NODE.FS_WATCH:
          void this.handleFsWatch(nodeId, request);
          break;
        case COORDINATOR_TO_NODE.FS_UNWATCH:
          void this.handleFsUnwatch(nodeId, request);
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
    // Auth: validate token on notifications too
    const params = notification.params as Record<string, unknown> | undefined;
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
      logger.warn('Notification rejected: invalid auth token', { nodeId, method: notification.method });
      return;
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
        this.registry.updateNodeMetrics(nodeId, {
          activeInstances: typeof hbParams?.['activeInstances'] === 'number'
            ? hbParams['activeInstances']
            : node.activeInstances,
        });
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

    this.connection.sendResponse(wsNodeId, createRpcResponse(request.id, { ok: true }));

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
    this.registry.updateNodeMetrics(nodeId, {
      activeInstances: typeof params?.['activeInstances'] === 'number'
        ? params['activeInstances']
        : node.activeInstances,
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private handleInstanceOutput(nodeId: string, request: RpcRequest): void {
    if (!this.registry.getNode(nodeId)) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;
    this.registry.emit('remote:instance-output', {
      nodeId,
      instanceId: params?.['instanceId'],
      message: params?.['message'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
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
    this.registry.emit('remote:instance-permission-request', {
      nodeId,
      instanceId: params?.['instanceId'],
      permission: params?.['permission'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  // ---------------------------------------------------------------------------
  // Filesystem handler helpers
  // ---------------------------------------------------------------------------

  private getFsHandler(nodeId: string): NodeFilesystemHandler | null {
    if (this.fsHandlers.has(nodeId)) return this.fsHandlers.get(nodeId)!;
    const node = this.registry.getNode(nodeId);
    if (!node) return null;
    const roots = node.capabilities.browsableRoots?.length > 0
      ? node.capabilities.browsableRoots
      : node.capabilities.workingDirectories;
    const handler = new NodeFilesystemHandler(roots);
    this.fsHandlers.set(nodeId, handler);
    return handler;
  }

  private async handleFsReadDirectory(nodeId: string, request: RpcRequest): Promise<void> {
    const fsHandler = this.getFsHandler(nodeId);
    if (!fsHandler) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fsHandler.readDirectory(request.params as any);
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
    } catch (err) {
      if (err instanceof FsRpcError) {
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.FILESYSTEM_ERROR, err.message, {
            fsCode: err.fsCode,
            path: err.fsPath,
            retryable: err.retryable,
            suggestion: err.suggestion,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Filesystem operation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
        );
      }
    }
  }

  private async handleFsStat(nodeId: string, request: RpcRequest): Promise<void> {
    const fsHandler = this.getFsHandler(nodeId);
    if (!fsHandler) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fsHandler.stat(request.params as any);
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
    } catch (err) {
      if (err instanceof FsRpcError) {
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.FILESYSTEM_ERROR, err.message, {
            fsCode: err.fsCode,
            path: err.fsPath,
            retryable: err.retryable,
            suggestion: err.suggestion,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Filesystem operation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
        );
      }
    }
  }

  private async handleFsSearch(nodeId: string, request: RpcRequest): Promise<void> {
    const fsHandler = this.getFsHandler(nodeId);
    if (!fsHandler) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fsHandler.search(request.params as any);
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
    } catch (err) {
      if (err instanceof FsRpcError) {
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.FILESYSTEM_ERROR, err.message, {
            fsCode: err.fsCode,
            path: err.fsPath,
            retryable: err.retryable,
            suggestion: err.suggestion,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Filesystem operation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
        );
      }
    }
  }

  private async handleFsWatch(nodeId: string, request: RpcRequest): Promise<void> {
    const fsHandler = this.getFsHandler(nodeId);
    if (!fsHandler) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await fsHandler.watch(request.params as any);
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, result));
    } catch (err) {
      if (err instanceof FsRpcError) {
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.FILESYSTEM_ERROR, err.message, {
            fsCode: err.fsCode,
            path: err.fsPath,
            retryable: err.retryable,
            suggestion: err.suggestion,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Filesystem operation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
        );
      }
    }
  }

  private async handleFsUnwatch(nodeId: string, request: RpcRequest): Promise<void> {
    const fsHandler = this.getFsHandler(nodeId);
    if (!fsHandler) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.NODE_NOT_FOUND, `Unknown node: ${nodeId}`),
      );
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fsHandler.unwatch(request.params as any);
      this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
    } catch (err) {
      if (err instanceof FsRpcError) {
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.FILESYSTEM_ERROR, err.message, {
            fsCode: err.fsCode,
            path: err.fsPath,
            retryable: err.retryable,
            suggestion: err.suggestion,
          }),
        );
      } else {
        const message = err instanceof Error ? err.message : 'Filesystem operation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INTERNAL_ERROR, message),
        );
      }
    }
  }
}
