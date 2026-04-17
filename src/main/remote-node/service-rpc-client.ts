import { getWorkerNodeConnectionServer } from './worker-node-connection';

export async function sendServiceRpc<T = unknown>(
  nodeId: string,
  method: string,
  params?: unknown,
  timeoutMs = 15_000,
): Promise<T> {
  const server = getWorkerNodeConnectionServer();
  return server.sendRpc<T>(nodeId, method, params, timeoutMs, 'service');
}
