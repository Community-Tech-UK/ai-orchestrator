/**
 * Plan Queue schemas for the Linear connection channels: which Harness connectors are Linear's, who one of them signs
 * in as, and whether the saved connection is usable. Re-exported from `plan-queue.schemas.ts`, so callers import them
 * from `@contracts/schemas/plan-queue`.
 *
 * Every sentence in these results is fixed words written by Harness plus a connector's name. Nothing Linear returned
 * appears in `reason`, because sessions can read a run's reason. The names and the email in an identity are Linear's
 * own words, shown on the page as plain text, and never placed in a prompt.
 */
import { z } from 'zod';

const ConnectorIdSchema = z.string().trim().min(1).max(200);

/** Identify: ask who one connector signs in as. Nothing is saved. */
export const PlanQueueLinearIdentifyPayloadSchema = z.object({ connectorId: ConnectorIdSchema }).strict();
/** Confirm: save the connection, but only if the connector still signs in as the user James was shown. */
export const PlanQueueLinearConfirmPayloadSchema = z.object({
  connectorId: ConnectorIdSchema,
  userId: ConnectorIdSchema,
}).strict();
/** List, check and forget take no input. */
export const PlanQueueLinearNoPayloadSchema = z.object({}).strict();

export type PlanQueueLinearIdentifyPayload = z.infer<typeof PlanQueueLinearIdentifyPayloadSchema>;
export type PlanQueueLinearConfirmPayload = z.infer<typeof PlanQueueLinearConfirmPayloadSchema>;

/** `checking` is the state after a restart until the first check finishes. It counts as not usable. */
export type PlanQueueLinearConnectionState =
  | 'not-set-up'
  | 'checking'
  | 'ready'
  | 'needs-sign-in'
  | 'someone-else'
  | 'connector-changed'
  | 'unreachable';

export type PlanQueueLinearConnectorProblem = 'gone' | 'off' | 'not-linear' | 'read-only';
export type PlanQueueLinearUnreachableCause = 'unreachable' | 'rate-limited' | 'unexpected';

export interface PlanQueueLinearConnectionSnapshot {
  state: PlanQueueLinearConnectionState;
  /** True only in `ready`. */
  usable: boolean;
  /** Fixed words for any state that is not usable; null when ready. */
  reason: string | null;
  connectorId: string | null;
  connectorName: string | null;
  /** The user James confirmed, as saved. */
  userName: string | null;
  workspaceName: string | null;
  /** Unix milliseconds of the last finished check, or null before the first. */
  checkedAt: number | null;
  /** Why the state is `connector-changed`. */
  connectorProblem: PlanQueueLinearConnectorProblem | null;
  /** Why the state is `unreachable`. */
  unreachableCause: PlanQueueLinearUnreachableCause | null;
  /** Unix milliseconds of the next automatic try while `unreachable`, otherwise null. */
  retryAt: number | null;
}

/** A Harness connector that is at Linear's address, offered on the page. `problem` is set when it cannot be used yet. */
export interface PlanQueueLinearConnectorChoice {
  connectorId: string;
  name: string;
  problem: 'off' | 'read-only' | null;
  /** Fixed words, set with `problem`. */
  problemReason: string | null;
}

export interface PlanQueueLinearListResult {
  connectors: PlanQueueLinearConnectorChoice[];
  connection: PlanQueueLinearConnectionSnapshot;
}

/** Who a connector signs in as, as Linear says, for James to confirm. */
export interface PlanQueueLinearIdentity {
  connectorId: string;
  userId: string;
  userName: string;
  userEmail: string;
  workspaceName: string;
}
