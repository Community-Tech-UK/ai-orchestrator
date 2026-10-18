import { getLogger } from '../logging/logger';
import { InstanceTelemetryParamsSchema } from './instance-telemetry-rpc';
import type { WorkerNodeRegistry } from './worker-node-registry';

const logger = getLogger('RpcInstanceTelemetry');

/** Per-message auth is enforced by the router before this bounded payload gate. */
export function routeInstanceTelemetry(
  nodeId: string,
  params: unknown,
  registry: Pick<WorkerNodeRegistry, 'getNode' | 'emit'>,
  acceptsFrame: (params: Record<string, unknown>) => boolean,
): void {
  const parsed = InstanceTelemetryParamsSchema.safeParse(params);
  if (!parsed.success || !registry.getNode(nodeId)) {
    logger.warn('Invalid or unregistered instance telemetry dropped', { nodeId });
    return;
  }
  if (!acceptsFrame(parsed.data)) return;
  registry.emit('remote:instance-telemetry', { nodeId, instanceId: parsed.data.instanceId, telemetry: parsed.data.telemetry });
}
