import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { sendServiceRpc } from '../../remote-node/service-rpc-client';

/** Stop a session that may still run on a computer (a restart here lost track of it). Best effort: the caller catches. */
export async function terminateRemoteSession(nodeId: string, instanceId: string): Promise<void> {
  await sendServiceRpc(nodeId, COORDINATOR_TO_NODE.INSTANCE_TERMINATE, { instanceId }, 15_000);
}
