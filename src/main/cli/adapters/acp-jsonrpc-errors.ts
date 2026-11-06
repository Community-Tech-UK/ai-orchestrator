import type { AcpJsonRpcErrorResponse } from '../../../shared/types/cli.types';
import { redactForSink } from '../../diagnostics/redaction';

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
  // Preserve what the supported ACP transport actually supplied. A JSON-RPC
  // code is not an HTTP status; missing upstream fields remain absent.
  // Decode JSON-encoded bodies before redaction so secret-keyed fields inside
  // them receive the same protection as ordinary structured error data.
  const captured = redactForSink({
    transport: 'acp-jsonrpc', jsonrpc: response.jsonrpc, id: response.id,
    error: {
      code: response.error.code, message: response.error.message,
      ...('data' in response.error ? { data: decodeErrorData(response.error.data) } : {}),
    },
  });
  const error = new Error(`ACP ${pending?.method ?? 'request'} failed: ${captured.error.message} (${captured.error.code})`, { cause: captured });
  if (pending && key) {
    clearTimeout(pending.timer);
    pendingRequests.delete(key);
    pending.reject(error);
    return;
  }
  emitError(error);
}

function decodeErrorData(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[omitted: deeply nested ACP error data]';
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === 'object') return decodeErrorData(parsed, depth + 1);
    } catch { /* Most provider messages are plain text. */ }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => decodeErrorData(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeErrorData(item, depth + 1)]));
  }
  return value;
}
