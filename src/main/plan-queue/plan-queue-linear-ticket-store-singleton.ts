/**
 * The app's one way to the Linear ticket table (`plan_queue_linear_tickets`), over the same database as the queue. It
 * is a thin wrapper over the driver, so a new one is made on each ask: nothing is cached that could outlive the
 * database. Null when the database is not available (the queue did not start).
 */
import { getLoopStoreService } from '../orchestration/loop-store';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';

export function getPlanQueueLinearTicketStore(): PlanQueueLinearTicketStore | null {
  const db = getLoopStoreService().getDb();
  return db ? new PlanQueueLinearTicketStore(db) : null;
}
