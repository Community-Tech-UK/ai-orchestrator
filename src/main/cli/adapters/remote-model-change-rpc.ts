/** A failed replacement must say whether the previous worker runtime survived. */
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { RPC_ERROR_CODES } from '../../remote-node/worker-node-rpc';

export function hasRemoteRpcErrorCode(error: unknown, code: number): boolean {
  return error instanceof Error && (('code' in error && error.code === code)
    || error.message.startsWith(`RPC error ${code}:`));
}

/** These refusals prove the worker never started replacement or teardown. */
export function isRemoteModelChangeRejected(error: unknown): boolean {
  return [RPC_ERROR_CODES.MODEL_CHANGE_REJECTED, RPC_ERROR_CODES.INVALID_PARAMS,
    RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.UNAUTHORIZED].some(code => hasRemoteRpcErrorCode(error, code));
}

export async function sendRemoteSpawnRpc<T>(
  connection: WorkerNodeConnectionServer,
  nodeId: string,
  spawnParams: unknown,
  previousInstanceId?: string,
): Promise<T> {
  if (!previousInstanceId) return connection.sendRpc<T>(nodeId, 'instance.spawn', spawnParams);
  return connection.sendRpc<T>(nodeId, 'instance.changeModel', {
    previousInstanceId, replacement: spawnParams,
  });
}
