import { getLogger } from '../logging/logger';
import { NODE_TO_COORDINATOR, createRpcResponse, createRpcError, RPC_ERROR_CODES } from './worker-node-rpc';
import { getWorkerNodeHealth } from './worker-node-health';
import { validateAuthToken } from './auth-validator';
import { validateRpcParams, RPC_PARAM_SCHEMAS } from './rpc-schemas';
import type { WorkerNodeConnectionServer } from './worker-node-connection';
import type { WorkerNodeRegistry } from './worker-node-registry';
import type { RpcRequest, RpcNotification } from './worker-node-rpc';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';

const logger = getLogger('RpcEventRouter');

export class RpcEventRouter {
  private readonly connection: WorkerNodeConnectionServer;
  private readonly registry: WorkerNodeRegistry;

  // Bound handler references so stop() can cleanly remove them
  private readonly onWsConnected: (nodeId: string) => void;
  private readonly onWsDisconnected: (nodeId: string) => void;
  private readonly onRpcRequest: (nodeId: string, request: RpcRequest) => void;
  private readonly onRpcNotification: (nodeId: string, notification: RpcNotification) => void;

  /** Methods handled as trusted notifications — skip per-message auth validation. */
  private readonly trustedNotificationMethods = new Set<string>([
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT,
    NODE_TO_COORDINATOR.INSTANCE_OUTPUT_BATCH,
    NODE_TO_COORDINATOR.INSTANCE_CONTEXT,
  ]);

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
        case NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE:
          this.handleInstanceStateChange(nodeId, request);
          break;
        case NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST:
          this.handleInstancePermissionRequest(nodeId, request);
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
      if (!validateAuthToken(token)) {
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
      case NODE_TO_COORDINATOR.INSTANCE_CONTEXT: {
        this.handleInstanceContext(nodeId, notification);
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

}
