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
  // code is not an HTTP status; missing upstream fields are never invented.
  // Decode JSON-encoded bodies before redaction so secret-keyed fields inside
  // them receive the same protection as ordinary structured error data.
  // OpenCode's real quota refusal carries a `data` object with no HTTP fields,
  // so name each missing one: otherwise a capture without them reads as if the
  // provider sent none, when the ACP transport simply did not forward them.
  const data = 'data' in response.error ? decodeErrorData(response.error.data) : undefined;
  const missingHttp = {
    ...(findKey(data, HTTP_STATUS_KEYS) === undefined ? { status: NOT_SUPPLIED } : {}),
    ...(findKey(data, HTTP_BODY_KEYS) === undefined ? { body: NOT_SUPPLIED } : {}),
  };
  const captured = redactForSink({
    transport: 'acp-jsonrpc', jsonrpc: response.jsonrpc, id: response.id,
    error: {
      code: response.error.code, message: response.error.message,
      ...(data !== undefined ? { data } : {}),
    },
    ...(Object.keys(missingHttp).length > 0 ? { upstreamHttp: missingHttp } : {}),
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

const NOT_SUPPLIED = 'not-supplied-by-acp';
const HTTP_STATUS_KEYS = ['statuscode', 'status', 'httpstatus'];
const HTTP_BODY_KEYS = ['responsebody', 'body', 'response'];

/** Depth-limited, case-insensitive search for the first defined value under one of `keys`. */
function findKey(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && item !== undefined && item !== null) return item;
  }
  for (const item of Object.values(value)) {
    const found = findKey(item, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
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
