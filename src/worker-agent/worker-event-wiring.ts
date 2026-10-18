/**
 * Event-forwarding wiring for the worker agent.
 *
 * Split out of worker-agent.ts to keep the agent class focused on lifecycle.
 * These functions subscribe to CDP-tunnel and instance-manager events and
 * forward them to the coordinator via the notifier.
 *
 * Electron isolation: this module (and its transitive imports) must never pull
 * in `electron`. Type-only imports are erased; RPC constants and the
 * in-process usage-settlement leaves are worker safe;
 * settlement callbacks never travel in serialized notifications.
 */
import type { EventEmitter } from 'events';
import type { CliResponse } from '../main/cli/adapters/base-cli-adapter.types';
import { deferUntilResponseUsageSettled } from '../main/cli/adapters/deferred-response-usage';
import { markRemoteUsageSettlement } from '../main/cli/adapters/remote-response-usage-settlement';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import { WORKER_NODE_WS_BACKPRESSURE_BYTES } from '../main/remote-node/rpc-schemas';
import type { WorkerConfig } from './worker-config';
import type { WorkerInstanceNotifier } from './worker-instance-notifier';
import type { WorkerCdpTunnel } from './worker-cdp-tunnel';
import type { InstanceTelemetry } from '../main/remote-node/instance-telemetry-rpc';

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
  source.on('instance:telemetry', (instanceId: string, telemetry: InstanceTelemetry) => {
    notifier.sendTelemetryNotification(instanceId, telemetry);
  });
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
    (instanceId: string, response: unknown, usageSettlementEnabled = false) => {
      // Preserve early semantic completion and its request identity. A marked
      // finalization updates only its bill, never completes a later input.
      // Older coordinators treat every frame as a semantic completion, so the
      // marked pair requires their explicit spawn opt-in. Keep that capability
      // in-process; it is not provider response metadata or a wire payload field.
      if (usageSettlementEnabled && deferUntilResponseUsageSettled(response as CliResponse,
        () => notifier.sendCompleteNotification(instanceId, markRemoteUsageSettlement(response as CliResponse, 'settled')))) {
        notifier.sendCompleteNotification(instanceId, markRemoteUsageSettlement(response as CliResponse, 'pending'));
        return;
      }
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
