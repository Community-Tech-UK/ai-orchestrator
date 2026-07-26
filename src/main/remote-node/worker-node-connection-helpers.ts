import type { NodePlatform } from '../../shared/types/worker-node.types';
import type { RpcRequest } from './worker-node-rpc';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import type { z } from 'zod/v4';

export const LOCAL_AI_HEALTH_MAX_RPC_RESPONSE_BYTES = 16 * 1024;

export class BoundedServiceRpcResponseError extends Error {
  constructor() {
    super('Service RPC response was invalid or exceeded its byte limit');
    this.name = 'BoundedServiceRpcResponseError';
  }
}

/**
 * Fail closed on service-RPC responses before any caller stores or logs them.
 * Error text deliberately excludes Zod issues and serialized response content.
 */
export function parseBoundedServiceRpcResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  maxBytes = LOCAL_AI_HEALTH_MAX_RPC_RESPONSE_BYTES,
): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BoundedServiceRpcResponseError();
  }
  if (typeof serialized !== 'string') {
    throw new BoundedServiceRpcResponseError();
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new BoundedServiceRpcResponseError();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BoundedServiceRpcResponseError();
  }
  return parsed.data;
}

/**
 * RPC methods that represent the coordinator actually *using* a remote node
 * (the "slave machine") to do real work — spawning/driving agents, offloading
 * auxiliary-LLM generation to the node's local model server, or opening a
 * remote terminal. These are logged at `info` so it's visible at a glance
 * whether offload is genuinely happening. Everything else (health pings,
 * filesystem reads, sync, terminal keystrokes) is routine and logged at
 * `debug` to keep the signal clean.
 */
export const WORK_DISPATCH_METHODS = new Set<string>([
  COORDINATOR_TO_NODE.INSTANCE_SPAWN,
  COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT,
  COORDINATOR_TO_NODE.INSTANCE_INTERRUPT,
  COORDINATOR_TO_NODE.INSTANCE_TERMINATE,
  COORDINATOR_TO_NODE.INSTANCE_HIBERNATE,
  COORDINATOR_TO_NODE.INSTANCE_WAKE,
  COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_START,
  COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_SEND_INPUT,
  COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_INTERRUPT,
  COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_TERMINATE,
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE,
  COORDINATOR_TO_NODE.AUXILIARY_MODEL_LIST,
  COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE,
  COORDINATOR_TO_NODE.TERMINAL_CREATE,
]);

export function isWorkerNodeWorkDispatchMethod(method: string): boolean {
  return WORK_DISPATCH_METHODS.has(method);
}

export function trustedPlatformFromParams(
  params: Record<string, unknown> | undefined,
): NodePlatform | undefined {
  const capabilities = params?.['capabilities'];
  if (!capabilities || typeof capabilities !== 'object') {
    return undefined;
  }
  const platform = (capabilities as Record<string, unknown>)['platform'];
  return platform === 'darwin' || platform === 'win32' || platform === 'linux'
    ? platform
    : undefined;
}

/**
 * Extract only safe, non-sensitive scalar fields from RPC params for logging.
 * Deliberately omits prompt/input/content/token fields so agent prompts and
 * secrets never reach the logs.
 */
export function summarizeRpcParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'instanceId',
    'provider',
    'model',
    'slot',
    'cliType',
    'cwd',
    'workingDirectory',
    'sessionId',
    'endpointProvider',
    'endpointId',
    'modelId',
    'kind',
    'action',
    'terminalId',
  ]) {
    const value = p[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function withConnectionAddress(request: RpcRequest, remoteAddress: string | undefined): RpcRequest {
  const address = remoteAddress?.trim();
  if (!address) return request;
  const params = request.params && typeof request.params === 'object'
    ? { ...(request.params as Record<string, unknown>), address }
    : { address };
  return { ...request, params };
}
