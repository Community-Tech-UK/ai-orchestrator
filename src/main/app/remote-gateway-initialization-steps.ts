import { getSettingsManager } from '../core/config/settings-manager';
import { getThinClientWsServer } from '../event-bus/thin-client-ws-server';
import { getLogger } from '../logging/logger';
import { getMobileGatewayServer } from '../mobile-gateway/mobile-gateway-server';
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  handleNodeFailover,
  handleLateNodeReconnect,
  RpcEventRouter,
  getRemoteNodeConfig,
  hydrateRemoteNodeConfig,
} from '../remote-node';
import type { InstanceManager } from '../instance/instance-manager';
import type { AppInitializationContext, AppInitializationStep } from './initialization-steps';

const logger = getLogger('AppInitialization');

export function createWorkerNodeSubsystemStep(
  context: AppInitializationContext,
): AppInitializationStep {
  const { instanceManager, windowManager } = context;
  return {
    name: 'Worker node subsystem',
    fn: async () => {
      hydrateRemoteNodeConfig(getSettingsManager().getAll());
      const config = getRemoteNodeConfig();
      if (!config.enabled) {
        logger.info('Remote node subsystem disabled');
        return;
      }

      const registry = getWorkerNodeRegistry();
      const connection = getWorkerNodeConnectionServer();
      const rpcRouter = new RpcEventRouter(connection, registry);
      rpcRouter.start();

      registry.on('node:disconnected', (node) => {
        const nodeId = typeof node === 'string' ? node : node.id;
        // Pause the per-instance stuck watchdog first: a network-starved node's
        // instances go silent on the coordinator but keep running locally, and
        // the watchdog would otherwise respawn them out from under live work.
        instanceManager.pauseStuckTrackingForNode(nodeId);
        handleNodeFailover(nodeId, instanceManager);
        context.syncRemoteNodeMetricsToLoadBalancer(nodeId);
      });

      registry.on('node:connected', (node) => {
        windowManager.sendToRenderer('remote-node:event', { type: 'connected', node });
        const nodeId = typeof node === 'string' ? node : node.id;
        instanceManager.resumeStuckTrackingForNode(nodeId);
        handleLateNodeReconnect(nodeId, instanceManager);
      });
      registry.on('node:disconnected', (node) => {
        windowManager.sendToRenderer('remote-node:event', {
          type: 'disconnected',
          nodeId: typeof node === 'string' ? node : node.id,
        });
      });
      registry.on('node:updated', (node) => {
        context.syncRemoteNodeMetricsToLoadBalancer(node.id);
        windowManager.sendToRenderer('remote-node:event', { type: 'updated', node });
      });

      await connection.start(config.serverPort, config.serverHost);
      logger.info('Worker node subsystem started', {
        port: config.serverPort,
        host: config.serverHost,
      });
    },
  };
}

export function createThinClientWsStep(): AppInitializationStep {
  return {
    name: 'Thin-client WebSocket',
    fn: async () => {
      const settings = getSettingsManager();
      if (!settings.get('thinClientWsEnabled')) {
        logger.info('Thin-client WebSocket disabled');
        return;
      }

      const status = await getThinClientWsServer().start({
        host: settings.get('thinClientWsHost'),
        port: settings.get('thinClientWsPort'),
      });
      logger.info('Thin-client WebSocket started from boot', {
        host: status.host,
        port: status.port,
      });
    },
  };
}

export function createMobileGatewayStep(instanceManager: InstanceManager): AppInitializationStep {
  return {
    name: 'Mobile gateway',
    fn: async () => {
      const settings = getSettingsManager();
      // Always initialize so the runtime start/stop IPC handlers work even
      // when the gateway is toggled on later from Settings -> Mobile.
      const gateway = getMobileGatewayServer();
      gateway.initialize({ instanceManager });
      if (!settings.get('mobileGatewayEnabled')) {
        logger.info('Mobile gateway disabled (initialized, not started)');
        return;
      }
      await gateway.start({
        port: settings.get('mobileGatewayPort'),
        bindInterface: settings.get('mobileGatewayBindInterface'),
        tlsCertPath: settings.get('mobileGatewayTlsCertPath'),
        tlsKeyPath: settings.get('mobileGatewayTlsKeyPath'),
      });
      logger.info('Mobile gateway started from boot');
    },
  };
}
