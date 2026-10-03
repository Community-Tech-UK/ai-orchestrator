import type { AcpJsonRpcErrorResponse } from '../../../shared/types/cli.types';

interface PendingAcpErrorRequest {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  reject(error: Error): void;
}

/** Settle error replies through the same pending-request ownership as success. */
export function settleAcpErrorResponse<T extends PendingAcpErrorRequest>(
  response: AcpJsonRpcErrorResponse,
  pendingRequests: Map<string, T>,
  emitError: (error: Error) => void,
): void {
  const key = response.id == null ? '' : String(response.id);
  const pending = key ? pendingRequests.get(key) : undefined;
  const error = new Error(`ACP ${pending?.method ?? 'request'} failed: ${response.error.message} (${response.error.code})`);
  if (pending && key) {
    clearTimeout(pending.timer);
    pendingRequests.delete(key);
    pending.reject(error);
    return;
  }
  emitError(error);
}
