/**
 * Event-forwarding wiring for the worker agent.
 *
 * Split out of worker-agent.ts to keep the agent class focused on lifecycle.
 * These functions subscribe to CDP-tunnel and instance-manager events and
 * forward them to the coordinator via the notifier.
 *
 * Electron isolation: this module (and its transitive imports) must never pull
 * in `electron`. All type-only imports are erased; the two runtime imports
 * (`NODE_TO_COORDINATOR`, `WORKER_NODE_WS_BACKPRESSURE_BYTES`) are the same ones
 * worker-agent already loads, so this introduces no new import graph.
 */
import type { EventEmitter } from 'events';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import { WORKER_NODE_WS_BACKPRESSURE_BYTES } from '../main/remote-node/rpc-schemas';
import type { WorkerConfig } from './worker-config';
import type { WorkerInstanceNotifier } from './worker-instance-notifier';
import type { WorkerCdpTunnel } from './worker-cdp-tunnel';

/**
 * Forward Chrome CDP frames (and socket close) from the tunnel up to the
 * coordinator as notifications. These ride the already-authenticated WS, so
 * the coordinator treats them as trusted high-frequency stream frames.
 */
export function wireCdpTunnelEvents(
  cdpTunnel: WorkerCdpTunnel,
  notifier: WorkerInstanceNotifier,
  config: WorkerConfig,
): void {
  cdpTunnel.on('message', ({ sessionId, frame }) => {
    const sent = notifier.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.BROWSER_CDP_MESSAGE,
      params: {
        sessionId,
        frame,
        token: config.nodeToken ?? config.authToken,
      },
    }, {
      highWatermarkBytes: WORKER_NODE_WS_BACKPRESSURE_BYTES,
    });
    if (!sent) {
      cdpTunnel.close(sessionId);
    }
  });
  cdpTunnel.on('closed', ({ sessionId }) => {
    notifier.send({
      jsonrpc: '2.0',
      method: NODE_TO_COORDINATOR.BROWSER_CDP_CLOSED,
      params: {
        sessionId,
        token: config.nodeToken ?? config.authToken,
      },
    });
  });
}

/**
 * Forward instance lifecycle events from both the CLI instance manager and the
 * local-model session manager up to the coordinator.
 */
export function wireInstanceEvents(
  instanceManager: EventEmitter,
  localModelSessionManager: EventEmitter,
  notifier: WorkerInstanceNotifier,
): void {
  wireInstanceEventSource(instanceManager, notifier);
  wireInstanceEventSource(localModelSessionManager, notifier);
}

function wireInstanceEventSource(source: EventEmitter, notifier: WorkerInstanceNotifier): void {
  source.on(
    'instance:output',
    (instanceId: string, message: unknown) => {
      notifier.sendOutputNotification(instanceId, message);
    }
  );

  source.on(
    'instance:heartbeat',
    (instanceId: string) => {
      notifier.sendHeartbeatNotification(instanceId);
    }
  );

  source.on(
    'instance:complete',
    (instanceId: string, response: unknown) => {
      notifier.sendCompleteNotification(instanceId, response);
    }
  );

  source.on(
    'instance:stateChange',
    (instanceId: string, state: unknown, info?: unknown) => {
      notifier.sendStateChange(instanceId, state, info);
    }
  );

  source.on(
    'instance:exit',
    (instanceId: string, info: unknown) => {
      notifier.sendExit(instanceId, info);
    }
  );

  source.on(
    'instance:permissionRequest',
    (instanceId: string, permission: unknown) => {
      notifier.sendPermissionRequest(instanceId, permission);
    }
  );

  source.on(
    'instance:context',
    (instanceId: string, usage: unknown) => {
      notifier.sendContextNotification(instanceId, usage);
    }
  );
}
