import { getRemoteAuthService } from '../auth/remote-auth';
import { CodexDeviceLoginDeliverParamsSchema, CodexDeviceLoginDeliverAckSchema, type CodexDeviceLoginDeliverParams } from './codex-device-login-rpc';
import type { CodexDeviceTransferRegistry } from './codex-device-transfer';
import type { RpcRequestResponder, WorkerNodeConnectionServer } from './worker-node-connection';
import { createRpcError, createRpcResponse, RPC_ERROR_CODES, type RpcRequest, type RpcNotification } from './worker-node-rpc';

const privateRequestId = /^codex-device-private-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Drop references before any generic route or logging can inspect this envelope. */
export function eraseCodexDeviceDelivery(message: RpcRequest | RpcNotification): void {
  if (message.params && typeof message.params === 'object' && 'code' in message.params) {
    message.params.code = '';
  }
  message.params = undefined;
  message.token = undefined;
}

/** Private dispatch only: never render schema issues, thrown errors, or arbitrary request IDs. */
export async function handleCodexDeviceDelivery(
  nodeId: string, request: RpcRequest, respond: RpcRequestResponder | undefined,
  connection: WorkerNodeConnectionServer, transfers: CodexDeviceTransferRegistry,
): Promise<void> {
  let payload: CodexDeviceLoginDeliverParams | undefined;
  let current: (() => boolean) | null = null;
  let response;
  try {
    if (typeof request.id !== 'string' || !privateRequestId.test(request.id) || !respond) return;
    current = connection.captureConfidentialResponder(nodeId, respond);
    if (!affirmative(current)) return;
    response = createRpcError(request.id, RPC_ERROR_CODES.UNAUTHORIZED, 'codex_device_delivery_refused');
    if (request.scope !== 'service'
      || typeof request.token !== 'string'
      || getRemoteAuthService().validateSessionToken(request.token, nodeId) !== true) return;
    const parsed = CodexDeviceLoginDeliverParamsSchema.safeParse(request.params);
    if (!parsed.success) return;
    payload = parsed.data;
    eraseCodexDeviceDelivery(request);
    if (!affirmative(current)) return;
    CodexDeviceLoginDeliverAckSchema.parse(await transfers.receive(nodeId, payload, current));
    response = createRpcResponse(request.id, { delivered: true });
  } catch {
    // The sole failure response is fixed above; private errors must never leave this boundary.
  } finally {
    eraseCodexDeviceDelivery(request);
    if (payload) payload.code = '';
    if (response && respond && affirmative(current)) {
      try { respond(response); } catch { /* A closed responder must not escape to generic logging. */ }
    }
  }
}

function affirmative(check: (() => boolean) | null): boolean {
  try {
    const proof = check?.();
    if (proof === true) return true;
    void Promise.resolve(proof).catch(() => undefined);
    return false;
  } catch { return false; }
}
