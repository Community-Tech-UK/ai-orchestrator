/**
 * B12 — Shared workflow lifecycle projection.
 *
 * The orchestrator runs several kinds of "unit of work", each with its own rich,
 * domain-specific status enum:
 *   - loops          (`LoopStatus`)          — long-running iterative agent runs
 *   - automation runs (`AutomationRunStatus`) — scheduled/triggered one-shot runs
 *   - instances      (`InstanceStatus`)       — live agent processes
 *
 * Those enums are intentionally NOT unified — each carries detail the others don't
 * need (hibernation, completion-review, provider-limit throttling, …). Collapsing
 * them into one enum would force every consumer to carry dead arms and lose meaning.
 *
 * What cross-cutting consumers (dashboards, "is anything still live?", run summaries,
 * the future thin-client event API) actually want is a *coarse projection*: which
 * lifecycle phase is this in, and if terminal, did it end cleanly, fail, or get
 * stopped. This module provides that projection without touching the source enums.
 *
 * Design notes:
 *  - Each projection is an exhaustive `switch` guarded by `assertNever`, so adding a
 *    new status to any source enum is a COMPILE error here until it's mapped. The
 *    projection is therefore self-maintaining — it can never silently fall behind.
 *  - Worker-node connection state and provider activity state are deliberately NOT
 *    projected here: a node connection is infrastructure, and `ActivityState` is an
 *    orthogonal provider signal (a `busy` instance can be activity-`idle`). Mapping
 *    them into a workflow lifecycle would be semantically wrong.
 *
 * This file has zero runtime dependencies beyond the type-only imports, so it is
 * safe to import from main, renderer, and worker contexts alike.
 */

import type { LoopStatus } from './loop.types';
import type { AutomationRunStatus } from './automation.types';
import type { InstanceStatus } from './instance.types';

/**
 * Terminal classification — a unit of work has stopped and will not resume on its own.
 *  - `completed`  reached a terminal state without error (clean end-of-life). NOTE:
 *                 this means "finished without failing", not "the produced work was
 *                 good" — quality is a separate concern the source enums may encode.
 *  - `failed`     stopped due to an error or failure-to-converge.
 *  - `cancelled`  deliberately stopped, superseded, or skipped (operator/policy).
 */
export type WorkflowTerminalState = 'completed' | 'failed' | 'cancelled';

/**
 * Coarse lifecycle phase every workflow-shaped status projects onto.
 * Non-terminal: `pending` (created, not yet running), `running` (actively working),
 * `paused` (intentionally suspended, resumable on its own or on a window reset),
 * `blocked` (waiting on something external — user input, permission, a node).
 */
export type WorkflowLifecyclePhase =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | WorkflowTerminalState;

function assertNever(value: never): never {
  throw new Error(`Unhandled workflow status: ${String(value)}`);
}

/** Project a `LoopStatus` onto the shared lifecycle phase. */
export function loopStatusToPhase(status: LoopStatus): WorkflowLifecyclePhase {
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    // Throttled on a provider usage/rate limit — resumes when the window resets,
    // so semantically a (resumable) pause, NOT a terminal failure.
    case 'provider-limit':
      return 'paused';
    case 'completed':
    case 'completed-needs-review': // a successful terminal state per LF-7 (NOT a failure)
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'error':
    case 'no-progress': // stalled without converging
    case 'cap-reached': // stopped without converging
    // Ping-pong terminal states — all stopped WITHOUT mutual convergence, so
    // they project as `failed` (not a clean completion). The UI distinguishes
    // them by their own labels; the lifecycle phase only cares "did it converge".
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable':
      return 'failed';
    default:
      return assertNever(status);
  }
}

/** Project an `AutomationRunStatus` onto the shared lifecycle phase. */
export function automationRunStatusToPhase(status: AutomationRunStatus): WorkflowLifecyclePhase {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'skipped': // didn't run by policy — terminal, non-failure
    case 'cancelled':
      return 'cancelled';
    default:
      return assertNever(status);
  }
}

/** Project an `InstanceStatus` onto the shared lifecycle phase. */
export function instanceStatusToPhase(status: InstanceStatus): WorkflowLifecyclePhase {
  switch (status) {
    case 'initializing':
      return 'pending';
    case 'ready':
    case 'idle':
    case 'busy':
    case 'processing':
    case 'thinking_deeply':
    case 'interrupting':
    case 'cancelling':
    case 'interrupt-escalating':
    case 'respawning':
    case 'waking':
      return 'running';
    case 'waiting_for_input':
    case 'waiting_for_permission':
    case 'degraded': // remote node disconnected; awaiting reconnection/failover
      return 'blocked';
    case 'hibernating':
    case 'hibernated':
      return 'paused';
    case 'terminated': // reached end-of-life cleanly
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'superseded': // replaced by an edit/fork retry
      return 'cancelled';
    default:
      return assertNever(status);
  }
}
