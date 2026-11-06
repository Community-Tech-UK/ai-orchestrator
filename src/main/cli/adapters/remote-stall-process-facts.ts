import { getLogger } from '../../logging/logger';
import type { StallProcessFacts } from '../../instance/stall-process-facts';
import { StallProcessFactsSchema } from '../../remote-node/stall-process-rpc';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { WorkerNodeRegistry } from '../../remote-node/worker-node-registry';

const logger = getLogger('RemoteCliAdapter');

/** Read only the owning worker's process facts, discarding stale session observations. */
export async function sampleRemoteStallProcessFacts(
  connection: Pick<WorkerNodeConnectionServer, 'sendRpc'>,
  registry: Pick<WorkerNodeRegistry, 'getNode'>,
  nodeId: string,
  readIdentity: () => { instanceId: string | null; interactionId: string },
  silenceMs: number,
): Promise<StallProcessFacts | null> {
  const { instanceId, interactionId } = readIdentity();
  if (!instanceId || registry.getNode(nodeId)?.capabilities.stallProcessSampling !== 1) return null;
  try {
    const result = await connection.sendRpc<unknown>(nodeId,
      'instance.sampleStallProcess', { instanceId, silenceMs }, 6000);
    const current = readIdentity();
    if (current.instanceId !== instanceId || current.interactionId !== interactionId || result === null) return null;
    return StallProcessFactsSchema.parse(result);
  } catch (error) {
    logger.warn('Remote stall process observation unavailable', {
      nodeId, instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
