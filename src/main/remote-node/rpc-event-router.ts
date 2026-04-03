import { getLogger } from '../logging/logger';
import { NODE_TO_COORDINATOR, createRpcResponse } from './worker-node-rpc';
import { getWorkerNodeHealth } from './worker-node-health';
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
      default:
        logger.warn('Unknown RPC method received', { nodeId, method: request.method });
    }
  }

  // ---------------------------------------------------------------------------
  // RPC notification dispatcher
  // ---------------------------------------------------------------------------

  private handleRpcNotification(nodeId: string, notification: RpcNotification): void {
    switch (notification.method) {
      case NODE_TO_COORDINATOR.HEARTBEAT: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params = notification.params as Record<string, any> | undefined;
        this.registry.updateHeartbeat(nodeId, params?.['capabilities'] as WorkerNodeCapabilities);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;
    const capabilities = params?.['capabilities'] as WorkerNodeCapabilities;
    this.registry.updateHeartbeat(nodeId, capabilities);
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private handleInstanceOutput(nodeId: string, request: RpcRequest): void {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params = request.params as Record<string, any> | undefined;
    this.registry.emit('remote:instance-state-change', {
      nodeId,
      instanceId: params?.['instanceId'],
      state: params?.['state'],
    });
    this.connection.sendResponse(nodeId, createRpcResponse(request.id, { ok: true }));
  }

  private handleInstancePermissionRequest(nodeId: string, request: RpcRequest): void {
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
