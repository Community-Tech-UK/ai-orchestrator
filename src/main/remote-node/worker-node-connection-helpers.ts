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

/**
 * Forensic snapshot attached to `Worker WebSocket closed`.
 *
 * A 1006 close carries no reason by definition — the TCP connection simply
 * went away — so the close code alone can never say why. On 2026-08-25 a
 * worker died at 16:06:44Z and stayed dead for 9.3 hours; reconstructing even
 * the basic shape of that failure needed the node's own log pulled off the
 * machine afterwards, because the coordinator had recorded nothing but
 * `{closeCode: 1006, closeReason: ''}`.
 *
 * These four fields are what actually discriminate the cases, and all of them
 * are already in memory at close time:
 *
 * - `sessionMs` — a long session that ends abruptly is a different failure
 *   from a socket that dies seconds after connecting (a crash loop).
 * - `heartbeatAgeMs` — **the most diagnostic one.** A *fresh* heartbeat at
 *   close means the process was healthy right up to the instant it vanished,
 *   which points at an abrupt external kill (TerminateProcess, a closed
 *   parent console, power loss). A *stale* heartbeat means the worker was
 *   already wedged — GC death spiral, event-loop block, a hung native call —
 *   and the socket drop is a symptom rather than the event.
 * - `inFlightWork` / `inFlightControl` — whether the worker died mid-task,
 *   and which methods were outstanding. Previously this was only recoverable
 *   by noticing follow-up `sendResponse: requesting socket is no longer
 *   active` warnings and correlating request ids by hand.
 * - `activeInstances` — how much was running on the node when it went.
 *
 * The three registry-derived fields are emitted together or not at all, because
 * that is the only way they actually occur: `registerNode`
 * (`rpc-event-router.ts`) seeds `connectedAt`, `lastHeartbeat` and
 * `activeInstances` in one object at registration, so a node can never be known
 * with only some of them. The single reachable "unknown" case is the registry
 * having already deregistered the node before this socket's close event fired —
 * and that is reported explicitly as `registryNode: 'absent'` rather than by
 * silently dropping the keys, so the reader can tell "we could not measure this"
 * apart from "we measured it and it was zero". The in-flight fields do not come
 * from the registry and are always emitted.
 *
 * Reading the result, combined with the close code on the same line:
 *
 * | close code | registry fields | reading |
 * | --- | --- | --- |
 * | 1008 | `registryNode: 'absent'` | **we** closed it. `worker-node-health` hit `DISCONNECT_THRESHOLD_MS`, deregistered, then closed the socket — so the worker was wedged or suspended (machine sleep, console QuickEdit freeze). |
 * | 1006 | fresh `heartbeatAgeMs` | healthy until the instant it vanished: an abrupt external kill (`TerminateProcess`, a closed parent console, power loss). This is the 2026-08-25 case. |
 * | 1006 | stale `heartbeatAgeMs` | already degrading, and the socket dropped before the health monitor's timeout fired. |
 *
 * Deliberately content-free, consistent with the close log it joins: counts,
 * ages and method names only, never payloads. `method` is always an RPC method
 * name — every `sendRpc` call site passes a literal or a `COORDINATOR_TO_NODE`
 * constant, never anything built from user or file content.
 */
export interface WorkerCloseForensicsInput {
  node: { connectedAt?: number; lastHeartbeat?: number; activeInstances?: number } | undefined;
  pending: readonly { nodeId: string; method: string; startedAt: number; isWork: boolean }[];
  nodeId: string;
  now?: number;
}

export function describeWorkerCloseForensics(
  input: WorkerCloseForensicsInput,
): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const { node } = input;
  const inFlight = input.pending.filter((p) => p.nodeId === input.nodeId);
  const work = inFlight.filter((p) => p.isWork);
  const control = inFlight.filter((p) => !p.isWork);
  const oldest = inFlight.reduce<number | null>(
    (acc, p) => (acc === null || p.startedAt < acc ? p.startedAt : acc),
    null,
  );
  return {
    ...(node === undefined
      ? { registryNode: 'absent' }
      : {
          ...(node.connectedAt !== undefined ? { sessionMs: now - node.connectedAt } : {}),
          ...(node.lastHeartbeat !== undefined
            ? { heartbeatAgeMs: now - node.lastHeartbeat }
            : {}),
          ...(node.activeInstances !== undefined ? { activeInstances: node.activeInstances } : {}),
        }),
    inFlightWork: work.length,
    inFlightControl: control.length,
    ...(inFlight.length > 0
      ? {
          inFlightMethods: [...new Set(inFlight.map((p) => p.method))].slice(0, 8),
          oldestInFlightMs: oldest === null ? null : now - oldest,
        }
      : {}),
  };
}
