/**
 * The one sentence for each state in which Linear work may not start. Step 4's start check and the Linear work source
 * (7.3) both call `linearConnectionReason`, so a run, the page and a notice always say the same thing.
 *
 * Sessions can read a run's reason, so it is fixed words written by Harness plus the connector's name. Nothing Linear
 * returned (a user's name, a workspace, an error message) is ever put in it. The connector's name is James's own.
 */
import type {
  PlanQueueLinearConnectionState,
  PlanQueueLinearConnectorProblem,
  PlanQueueLinearUnreachableCause,
} from '@contracts/schemas/plan-queue';

export interface LinearConnectionReasonInput {
  state: PlanQueueLinearConnectionState;
  /** The connector's name; null when it no longer exists. */
  connectorName: string | null;
  connectorProblem: PlanQueueLinearConnectorProblem | null;
  unreachableCause: PlanQueueLinearUnreachableCause | null;
}

const NAME_LIMIT = 80;

function nameOf(connectorName: string | null): string {
  const clean = connectorName?.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
  return clean ? `"${clean}"` : 'the Linear connector';
}

/** Why Linear work is paused, or null when the connection is ready. */
export function linearConnectionReason(input: LinearConnectionReasonInput): string | null {
  const name = nameOf(input.connectorName);
  switch (input.state) {
    case 'ready':
      return null;
    case 'not-set-up':
      return 'Linear work is paused: no Linear connection has been chosen yet. Choose one on the Plan Queue page.';
    case 'checking':
      return `Linear work is paused while Harness checks the connection to ${name}.`;
    case 'needs-sign-in':
      return `Linear work is paused: sign in to ${name} again in Settings → Connectors.`;
    case 'someone-else':
      return `Linear work is paused: ${name} now signs in to Linear as someone other than the person you confirmed. Check it on the Plan Queue page.`;
    case 'connector-changed':
      switch (input.connectorProblem) {
        case 'off':
          return `Linear work is paused: ${name} is turned off. Turn it on in Settings → Connectors.`;
        case 'read-only':
          return `Linear work is paused: ${name} uses Linear's read-only address. Change it to the read and write address in Settings → Connectors.`;
        case 'not-linear':
          return `Linear work is paused: ${name} no longer points at Linear. Check its address in Settings → Connectors.`;
        default:
          return 'Linear work is paused: the Linear connector you chose has been removed. Choose one on the Plan Queue page.';
      }
    case 'unreachable':
      switch (input.unreachableCause) {
        case 'rate-limited':
          return 'Linear work is paused: Linear is limiting requests. Harness will try again soon.';
        case 'unexpected':
          return 'Linear work is paused: Linear sent an answer Harness could not read. Harness will try again soon.';
        default:
          return `Linear work is paused: Harness cannot reach Linear through ${name}. Harness will try again soon.`;
      }
  }
}
