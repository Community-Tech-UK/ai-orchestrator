import { COORDINATOR_TO_NODE } from '../../main/remote-node/worker-node-rpc';
import {
  QueueCollectParamsSchema, QueueCollectResultSchema, QueueDeleteLeftOutParamsSchema, QueueDeleteLeftOutResultSchema,
  QueueFetchPackParamsSchema, QueueFetchPackResultSchema, QueueHaveParamsSchema, QueueHaveResultSchema,
  QueuePrepareParamsSchema, QueuePrepareResultSchema, QueueProjectCheckParamsSchema, QueueProjectCheckResultSchema,
  QueueReadReportParamsSchema, QueueReadReportResultSchema, QueueReceiveParamsSchema, QueueReceiveResultSchema,
  QueueRemoveParamsSchema, QueueRemoveResultSchema, type QueueJobHostApi,
} from '../../main/remote-node/queue-job-rpc-schemas';

/**
 * One `queue.*` call: parse the params with the contract's schema, run the host, and parse the result with the
 * result schema (as the `node.exec` case does). A schema failure throws a `ZodError`, which the dispatcher turns
 * into an invalid-params error; the host is never reached with malformed params.
 */
export async function runQueueJobCall(host: QueueJobHostApi, method: string | undefined, params: unknown): Promise<unknown> {
  switch (method) {
    case COORDINATOR_TO_NODE.QUEUE_HAVE:
      return QueueHaveResultSchema.parse(await host.have(QueueHaveParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_RECEIVE:
      return QueueReceiveResultSchema.parse(await host.receive(QueueReceiveParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_PREPARE:
      return QueuePrepareResultSchema.parse(await host.prepare(QueuePrepareParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_COLLECT:
      return QueueCollectResultSchema.parse(await host.collect(QueueCollectParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_FETCH_PACK:
      return QueueFetchPackResultSchema.parse(await host.fetchPack(QueueFetchPackParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_READ_REPORT:
      return QueueReadReportResultSchema.parse(await host.readReport(QueueReadReportParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_DELETE_LEFT_OUT:
      return QueueDeleteLeftOutResultSchema.parse(await host.deleteLeftOut(QueueDeleteLeftOutParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_REMOVE:
      return QueueRemoveResultSchema.parse(await host.remove(QueueRemoveParamsSchema.parse(params)));
    case COORDINATOR_TO_NODE.QUEUE_PROJECT_CHECK:
      return QueueProjectCheckResultSchema.parse(await host.projectCheck(QueueProjectCheckParamsSchema.parse(params)));
    default:
      throw new Error(`Unknown queue method: ${method}`);
  }
}
