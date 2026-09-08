import { getSettingsManager } from '../core/config/settings-manager';
import { getThinClientWsServer } from '../event-bus/thin-client-ws-server';
import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import { getMobileGatewayServer } from '../mobile-gateway/mobile-gateway-server';
import { setBrowserEscalationNotifyHook } from '../browser-gateway/browser-unattended-services';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  handleNodeFailover,
  handleLateNodeReconnect,
  RpcEventRouter,
  getRemoteNodeConfig,
  hydrateRemoteNodeConfig,
  getDiscoveryService,
} from '../remote-node';
import type { InstanceManager } from '../instance/instance-manager';
import type { AppInitializationContext, AppInitializationStep } from './initialization-steps';
import type { RemoteFsEventNotification } from '../../shared/types/remote-fs.types';

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

      // Surface connection flap storms to the renderer so a flapping node is
      // visible to the operator instead of silently churning through work.
      connection.on('node:flap-storm', (info: {
        nodeId: string;
        nodeName?: string;
        replacesInWindow?: number;
        windowMs?: number;
      }) => {
        windowManager.sendToRenderer('remote-node:event', {
          type: 'flap-storm',
          nodeId: info.nodeId,
          nodeName: info.nodeName,
          replacesInWindow: info.replacesInWindow,
          windowMs: info.windowMs,
        });
      });

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
        const nodeId = typeof node === 'string' ? node : node.id;
        const nodeName = typeof node === 'string' ? node : node.name;
        windowManager.sendToRenderer('remote-node:event', {
          type: 'disconnected',
          nodeId,
        });
        // Nothing else tells the operator. On 2026-09-07 a node dropped at 09:31
        // and was noticed nearly four hours later only because someone happened
        // to ask. The name has to come off the event: deregisterNode() removes
        // the node from the registry BEFORE it emits, so getNode() here is
        // always undefined.
        if (getSettingsManager().get('notifyOnNodeDisconnect') === false) return;
        getNotificationService().notify({
          kind: 'node-disconnected',
          title: 'Worker node disconnected',
          body: `${nodeName} is no longer connected`,
          // Critical on purpose: it bypasses quiet hours and the per-kind
          // cooldown. An overnight drop is precisely the case worth waking
          // someone for — the incident this exists for ran from 09:31 to 13:28
          // unnoticed, and a night-time one would simply run longer.
          // Fingerprint dedupe is checked BEFORE the urgency branches
          // (notification-service.ts:162), so ONE flapping node still collapses
          // into a single alert rather than a stream.
          //
          // Accepted tradeoff: that dedupe is per {kind, nodeId}, while the
          // cooldown critical skips is per kind. So N *different* nodes dropping
          // together produce N alerts with no digest. That is deliberate — a
          // simultaneous multi-node drop is a bigger event than a single one,
          // not a smaller one, and silently collapsing it would hide the blast
          // radius. Revisit if this ever runs against a large fleet.
          urgency: 'critical',
          fingerprintFields: { nodeId },
        });
      });
      registry.on('node:updated', (node) => {
        context.syncRemoteNodeMetricsToLoadBalancer(node.id);
        windowManager.sendToRenderer('remote-node:event', { type: 'updated', node });
      });
      registry.on('remote:fs-event', (event: RemoteFsEventNotification) => {
        windowManager.sendToRenderer(IPC_CHANNELS.REMOTE_FS_EVENT, event);
      });

      await connection.start(config.serverPort, config.serverHost);
      // Advertise over mDNS here, not only from the Settings "start server" IPC
      // handler. Workers keep a discovery browser running for their whole
      // lifetime and fall back to a discovered address when their pinned
      // coordinator URL stops answering — but only if something is advertising.
      // Publishing solely from the IPC path meant a normally-started coordinator
      // never advertised, so on 2026-09-07 a worker pinned to a dead Tailscale
      // address retried it for four hours with a working LAN path available.
      getDiscoveryService().publish(config.serverPort, config.namespace, config.namespace);
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
      // Unattended browser campaigns page the phone when they park a hard
      // stop (captcha, failed re-login, …). Wired here — not inside the
      // escalation service — so the browser gateway stays free of a
      // mobile-gateway import. No-op when APNs is not configured.
      setBrowserEscalationNotifyHook((escalation) => {
        gateway.notifyBrowserEscalation({
          escalationId: escalation.id,
          kind: escalation.kind,
          profileId: escalation.profileId,
          ...(escalation.campaignId ? { campaignId: escalation.campaignId } : {}),
          reason: escalation.reason,
        });
      });
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
