/**
 * Built-in pre-termination gates (plan C6).
 *
 * The TerminationGateManager framework existed but had zero production gates
 * registered, so it was always fail-open with nothing to evaluate. These gates
 * give it real work while staying strictly advisory: they NEVER block shutdown
 * (the manager treats a non-pass result as a warning + event, and bounds each
 * gate with a timeout). They exist to surface in-flight work that a teardown
 * would otherwise silently drop.
 */

import type {
  SessionTerminationGate,
  TerminationGateResult,
} from './termination-gate-manager';
import type { SessionContinuityManager, SessionState } from './session-continuity';
import { getLogger } from '../logging/logger';

const logger = getLogger('BuiltinTerminationGates');

/** Pending-task types that represent in-flight work lost on an abrupt teardown. */
const IN_FLIGHT_TASK_TYPES = new Set(['tool_execution', 'approval_required']);

/**
 * Validate that no parallel tool executions / unanswered approvals are still
 * in flight when a session is torn down (plan C6 / opencode terminal-finalizer
 * idea). Advisory: returns `{ pass: false, data }` to surface the dropped work
 * via the manager's `gate:blocked` / `gate:summary` events — termination still
 * proceeds.
 */
export function createPendingToolResultsGate(): SessionTerminationGate {
  return {
    name: 'pending-tool-results',
    // Short bound — this is a synchronous inspection; never hold up shutdown.
    timeoutMs: 2_000,
    async validate(state: SessionState): Promise<TerminationGateResult> {
      const inFlight = (state.pendingTasks ?? []).filter((t) =>
        IN_FLIGHT_TASK_TYPES.has(t.type),
      );
      if (inFlight.length === 0) {
        return { pass: true };
      }
      return {
        pass: false,
        reason: `${inFlight.length} in-flight task(s) (tool/approval) were unresolved at termination`,
        data: {
          tasks: inFlight.map((t) => ({ id: t.id, type: t.type, description: t.description })),
        },
      };
    },
  };
}

/**
 * Register all built-in termination gates on the continuity manager. Idempotent
 * per gate name (the manager re-registers by push; callers should invoke once).
 */
export function registerBuiltinTerminationGates(continuity: SessionContinuityManager): void {
  continuity.registerTerminationGate(createPendingToolResultsGate());
  logger.info('Registered built-in termination gates', { gates: ['pending-tool-results'] });
}
