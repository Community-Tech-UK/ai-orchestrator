/**
 * JSON-RPC 2.0 message types for coordinator <-> worker node communication.
 */

// -- RPC Method Constants --

/** Methods sent FROM worker node TO coordinator */
export const NODE_TO_COORDINATOR = {
  REGISTER: 'node.register',
  HEARTBEAT: 'node.heartbeat',
  INSTANCE_OUTPUT: 'instance.output',
  INSTANCE_OUTPUT_BATCH: 'instance.outputBatch',
  INSTANCE_STATE_CHANGE: 'instance.stateChange',
  INSTANCE_PERMISSION_REQUEST: 'instance.permissionRequest',
  INSTANCE_CONTEXT: 'instance.context',
  FS_EVENT: 'fs.event'
} as const;

/** Methods sent FROM coordinator TO worker node */
export const COORDINATOR_TO_NODE = {
  INSTANCE_SPAWN: 'instance.spawn',
  INSTANCE_SEND_INPUT: 'instance.sendInput',
  INSTANCE_TERMINATE: 'instance.terminate',
  INSTANCE_INTERRUPT: 'instance.interrupt',
  INSTANCE_HIBERNATE: 'instance.hibernate',
  INSTANCE_WAKE: 'instance.wake',
  NODE_PING: 'node.ping',
  FS_READ_DIRECTORY: 'fs.readDirectory',
  FS_STAT: 'fs.stat',
  FS_SEARCH: 'fs.search',
  FS_WATCH: 'fs.watch',
  FS_UNWATCH: 'fs.unwatch',
  FS_READ_FILE: 'fs.readFile',
  FS_WRITE_FILE: 'fs.writeFile',
  SYNC_SCAN_DIRECTORY: 'sync.scanDirectory',
  SYNC_GET_BLOCK_SIGNATURES: 'sync.getBlockSignatures',
  SYNC_COMPUTE_DELTA: 'sync.computeDelta',
  SYNC_APPLY_DELTA: 'sync.applyDelta',
  SYNC_DELETE_FILE: 'sync.deleteFile',
  SERVICE_STATUS: 'service.status',
  SERVICE_RESTART: 'service.restart',
  SERVICE_STOP: 'service.stop',
  SERVICE_UNINSTALL: 'service.uninstall'
} as const;

export type RpcScope = 'instance' | 'service';

// -- JSON-RPC 2.0 Message Types --

export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
  token?: string;
  scope?: RpcScope;
}

export interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: RpcError;
}

export interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  token?: string;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Response sent to worker after successful enrollment */
export interface EnrollmentResult {
  nodeId: string;
  token: string;
}

// -- Standard JSON-RPC Error Codes --

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32000,
  NODE_NOT_FOUND: -32001,
  INSTANCE_NOT_FOUND: -32002,
  SPAWN_FAILED: -32003,
  FILESYSTEM_ERROR: -32004
} as const;

// -- Helpers --

export function createRpcRequest(
  id: string | number,
  method: string,
  params?: unknown,
  token?: string,
  scope?: RpcScope
): RpcRequest {
  return { jsonrpc: '2.0', id, method, params, token, scope };
}

export function createRpcResponse(
  id: string | number,
  result: unknown
): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export function createRpcError(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export function createRpcNotification(
  method: string,
  params?: unknown,
  token?: string
): RpcNotification {
  return { jsonrpc: '2.0', method, params, token };
}

export function isRpcRequest(msg: unknown): msg is RpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcRequest).jsonrpc === '2.0' &&
    'id' in msg &&
    'method' in msg
  );
}

export function isRpcResponse(msg: unknown): msg is RpcResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcResponse).jsonrpc === '2.0' &&
    'id' in msg &&
    !('method' in msg)
  );
}

export function isRpcNotification(msg: unknown): msg is RpcNotification {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as RpcNotification).jsonrpc === '2.0' &&
    'method' in msg &&
    !('id' in msg)
  );
}
