/**
 * The connection from this Mac to a computer that runs Plan Queue jobs: one typed method per `queue.*` worker call.
 * Params are built from the contract's types (src/main/remote-node/queue-job-rpc-schemas.ts) and every answer is
 * parsed with the contract's result schema, so nothing downstream sees an unchecked value.
 *
 * `RpcQueueJobLink` is the real thing (the service RPC channel); tests pass a fake `QueueJobLink`.
 */
import { createHash } from 'node:crypto';
import type { ZodType } from 'zod/v4';
import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import { sendServiceRpc } from '../../remote-node/service-rpc-client';
import {
  QUEUE_JOBS_PROTOCOL,
  QueueCollectResultSchema, QueueDeleteLeftOutResultSchema, QueueFetchPackResultSchema, QueueHaveResultSchema,
  QueuePrepareResultSchema, QueueProjectCheckResultSchema, QueueReadReportResultSchema, QueueReceiveResultSchema,
  QueueRemoveResultSchema, queueProjectKey,
  type QueueCollectParams, type QueueCollectResult, type QueueDeleteLeftOutParams, type QueueDeleteLeftOutResult,
  type QueueFetchPackParams, type QueueFetchPackResult, type QueueHaveParams, type QueueHaveResult,
  type QueuePrepareParams, type QueuePrepareResult, type QueueProjectCheckParams, type QueueProjectCheckResult,
  type QueueReadReportParams, type QueueReadReportResult, type QueueReceiveParams, type QueueReceiveResult,
  type QueueRemoveParams, type QueueRemoveResult,
} from '../../remote-node/queue-job-rpc-schemas';
import type { WorkerNodeInfo } from '../../../shared/types/worker-node.types';

/**
 * `unsupported`: the computer is connected but is an older build that has no `queue.*` calls.
 * `away`: it is not connected, or the connection dropped or timed out during the call.
 * `failed`: it answered with an error, or with something Harness could not read.
 */
export type QueueJobLinkErrorKind = 'unsupported' | 'away' | 'failed';

export class QueueJobLinkError extends Error {
  constructor(readonly kind: QueueJobLinkErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QueueJobLinkError';
  }
}

/** One method per worker call; `nodeId` is the paired computer's node id. */
export interface QueueJobLink {
  /** Connected and advertising `queueJobs: 1`. */
  supports(nodeId: string): boolean;
  have(nodeId: string, params: QueueHaveParams): Promise<QueueHaveResult>;
  receive(nodeId: string, params: QueueReceiveParams): Promise<QueueReceiveResult>;
  prepare(nodeId: string, params: QueuePrepareParams): Promise<QueuePrepareResult>;
  collect(nodeId: string, params: QueueCollectParams): Promise<QueueCollectResult>;
  fetchPack(nodeId: string, params: QueueFetchPackParams): Promise<QueueFetchPackResult>;
  readReport(nodeId: string, params: QueueReadReportParams): Promise<QueueReadReportResult>;
  deleteLeftOut(nodeId: string, params: QueueDeleteLeftOutParams): Promise<QueueDeleteLeftOutResult>;
  remove(nodeId: string, params: QueueRemoveParams): Promise<QueueRemoveResult>;
  projectCheck(nodeId: string, params: QueueProjectCheckParams): Promise<QueueProjectCheckResult>;
}

/** What the real link reads from outside; replaced in specs. */
export interface RpcQueueJobLinkDeps {
  getNode(nodeId: string): Pick<WorkerNodeInfo, 'name' | 'status' | 'capabilities'> | undefined;
  send(nodeId: string, method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

const SECOND = 1_000;
/** Per-call limits. `prepare` may install dependencies again and a project check runs the project's scripts. */
export const QUEUE_CALL_TIMEOUT_MS = {
  have: 30 * SECOND,
  receive: 2 * 60 * SECOND,
  prepare: 15 * 60 * SECOND,
  collect: 5 * 60 * SECOND,
  fetchPack: 2 * 60 * SECOND,
  readReport: 20 * SECOND,
  deleteLeftOut: 30 * SECOND,
  remove: 2 * 60 * SECOND,
  projectCheck: 30 * 60 * SECOND,
} as const;

const defaultDeps: RpcQueueJobLinkDeps = {
  getNode: nodeId => getWorkerNodeRegistry().getNode(nodeId),
  send: (nodeId, method, params, timeoutMs) => sendServiceRpc(nodeId, method, params, timeoutMs),
};

export class RpcQueueJobLink implements QueueJobLink {
  constructor(private readonly deps: RpcQueueJobLinkDeps = defaultDeps) {}

  supports(nodeId: string): boolean {
    const node = this.deps.getNode(nodeId);
    // Capabilities reach the registry unparsed: accept only the exact value, as the push guard check does.
    return node?.status === 'connected' && node.capabilities?.queueJobs === QUEUE_JOBS_PROTOCOL;
  }

  have(nodeId: string, params: QueueHaveParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_HAVE, params, QueueHaveResultSchema, QUEUE_CALL_TIMEOUT_MS.have);
  }
  receive(nodeId: string, params: QueueReceiveParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_RECEIVE, params, QueueReceiveResultSchema, QUEUE_CALL_TIMEOUT_MS.receive);
  }
  prepare(nodeId: string, params: QueuePrepareParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_PREPARE, params, QueuePrepareResultSchema, QUEUE_CALL_TIMEOUT_MS.prepare);
  }
  collect(nodeId: string, params: QueueCollectParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_COLLECT, params, QueueCollectResultSchema, QUEUE_CALL_TIMEOUT_MS.collect);
  }
  fetchPack(nodeId: string, params: QueueFetchPackParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_FETCH_PACK, params, QueueFetchPackResultSchema, QUEUE_CALL_TIMEOUT_MS.fetchPack);
  }
  readReport(nodeId: string, params: QueueReadReportParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_READ_REPORT, params, QueueReadReportResultSchema, QUEUE_CALL_TIMEOUT_MS.readReport);
  }
  deleteLeftOut(nodeId: string, params: QueueDeleteLeftOutParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_DELETE_LEFT_OUT, params, QueueDeleteLeftOutResultSchema, QUEUE_CALL_TIMEOUT_MS.deleteLeftOut);
  }
  remove(nodeId: string, params: QueueRemoveParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_REMOVE, params, QueueRemoveResultSchema, QUEUE_CALL_TIMEOUT_MS.remove);
  }
  projectCheck(nodeId: string, params: QueueProjectCheckParams) {
    return this.call(nodeId, COORDINATOR_TO_NODE.QUEUE_PROJECT_CHECK, params, QueueProjectCheckResultSchema, QUEUE_CALL_TIMEOUT_MS.projectCheck);
  }

  private async call<T>(nodeId: string, method: string, params: unknown, schema: ZodType<T>, timeoutMs: number): Promise<T> {
    const node = this.deps.getNode(nodeId);
    const name = node?.name ?? 'that computer';
    if (!node || node.status !== 'connected') throw new QueueJobLinkError('away', `${name} is not connected.`);
    if (!this.supports(nodeId)) {
      throw new QueueJobLinkError('unsupported', `${name} is running an older version of the Harness worker that cannot run Plan Queue jobs. Update it, or run the job on this computer.`);
    }
    let raw: unknown;
    try {
      raw = await this.deps.send(nodeId, method, params, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The connection layer words a worker's own error `RPC error <code>: ...`; everything else is the connection.
      if (message.startsWith('RPC error')) {
        throw new QueueJobLinkError('failed', `${name} could not do that: ${message.replace(/^RPC error [^:]*:\s*/, '')}`, { cause: error });
      }
      throw new QueueJobLinkError('away', `${name} stopped answering (${message}).`, { cause: error });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new QueueJobLinkError('failed', `${name} sent an answer Harness could not read (${method}).`, { cause: parsed.error });
    }
    return parsed.data;
  }
}

/** The real link, over the service connection to the paired computer. */
export function createQueueJobLink(): QueueJobLink {
  return new RpcQueueJobLink();
}

/** The project's name on the computers (`queueProjectKey` with this Mac's hash), also the key of `QueueJobComputer.projects`. */
export function queueProjectKeyFor(repoRoot: string): string {
  return queueProjectKey(repoRoot, value => createHash('sha256').update(value).digest('hex'));
}
