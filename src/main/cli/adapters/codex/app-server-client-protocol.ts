import type { JsonRpcResponse } from './app-server-types';
import { CODEX_APP_SERVER_PROTOCOL } from './generated/app-server-protocol.gen';
import {
  CodexAppServerRuntimeError,
  classifyCodexAppServerFailure,
  type CodexAppServerFailureKind,
  type CodexAppServerRecoverability,
} from './app-server-runtime-errors';

interface GeneratedResponseContract {
  kind: 'object' | 'empty-object';
  requiredKeys: readonly string[];
}

interface GeneratedRequestContract {
  requiredKeys: readonly string[];
  supportedKeys: readonly string[];
}

const RESPONSE_CONTRACTS = CODEX_APP_SERVER_PROTOCOL.responseContracts as unknown as
  Record<string, GeneratedResponseContract>;
const REQUEST_CONTRACTS = CODEX_APP_SERVER_PROTOCOL.requestContracts as unknown as
  Record<string, GeneratedRequestContract>;

export function validateGeneratedRequest(method: string, params: unknown): void {
  const contract = REQUEST_CONTRACTS[method];
  if (!contract) return;
  if (!isRecord(params)) throw protocolFailure(method, 'expected object params');
  const missingKey = contract.requiredKeys.find((key) => !(key in params));
  if (missingKey) throw protocolFailure(method, `missing required parameter: ${missingKey}`);
  const unsupportedKey = Object.keys(params).find((key) => !contract.supportedKeys.includes(key));
  if (unsupportedKey) throw protocolFailure(method, `unsupported parameter: ${unsupportedKey}`);
}

export function validateGeneratedResponse(method: string, result: unknown): unknown {
  const contract = RESPONSE_CONTRACTS[method];
  if (!contract) return result;
  if (!isRecord(result)) throw protocolFailure(method, 'expected an object result');
  if ((method === 'thread/start' || method === 'thread/resume') && typeof result['threadId'] === 'string') {
    return result;
  }
  const missingKey = contract.requiredKeys.find((key) => !(key in result));
  if (missingKey) throw protocolFailure(method, `missing required key: ${missingKey}`);
  return result;
}

export function transportFailure(method: string, message: string, cause?: unknown): CodexAppServerRuntimeError {
  return failure('transport-closed', 'retry-thread', method, message, cause);
}

export function timeoutFailure(method: string, timeoutMs: number): CodexAppServerRuntimeError {
  return failure(
    'request-timeout',
    'retry-thread',
    method,
    `RPC timeout: ${method} did not respond within ${timeoutMs}ms`,
  );
}

export function rpcFailure(
  method: string,
  error: NonNullable<JsonRpcResponse['error']>,
): CodexAppServerRuntimeError {
  const message = error.message || 'Unknown RPC error';
  const classified = classifyCodexAppServerFailure(new Error(message));
  const result = failure(
    classified.kind === 'unknown' ? 'request-rejected' : classified.kind,
    classified.recoverability === 'unknown' ? 'terminal' : classified.recoverability,
    method,
    message,
    error,
    error.code,
  );
  return result;
}

function protocolFailure(method: string, detail: string): CodexAppServerRuntimeError {
  return failure(
    'protocol-invalid',
    'terminal',
    method,
    `Codex app-server response for ${method} is invalid: ${detail}`,
  );
}

function failure(
  kind: CodexAppServerFailureKind,
  recoverability: CodexAppServerRecoverability,
  method: string,
  message: string,
  cause?: unknown,
  rpcCode?: number,
): CodexAppServerRuntimeError {
  return new CodexAppServerRuntimeError({ kind, recoverability, method, message, cause, rpcCode });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
