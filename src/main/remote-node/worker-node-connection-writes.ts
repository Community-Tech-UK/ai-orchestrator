import type { WebSocket } from 'ws';
import { getWorkAdmission } from '../work-admission/work-admission';
import { getLogger } from '../logging/logger';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { WORK_DISPATCH_METHODS } from './worker-node-connection-helpers';
const logger = getLogger('WorkerNodeConnection');
// Normal quit must still release idle remote providers while admission is fenced.
const STOP_WORK_METHODS = new Set<string>([
  COORDINATOR_TO_NODE.INSTANCE_INTERRUPT, COORDINATOR_TO_NODE.INSTANCE_TERMINATE,
  COORDINATOR_TO_NODE.INSTANCE_HIBERNATE, COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_INTERRUPT,
  COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_TERMINATE,
]);
export function assertWorkerNodeStartAllowed(method: string): void {
  if (WORK_DISPATCH_METHODS.has(method) && !STOP_WORK_METHODS.has(method)) getWorkAdmission().assertNotInMaintenance();
}
/** A write failure after the handoff can only be logged. */
export function sendWorkerNodeFrame(ws: WebSocket, raw: string, failure: string, meta: Record<string, unknown>): void {
  ws.send(raw, err => {
    if (err) logger.error(failure, err, meta);
  });
}
