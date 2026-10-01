import type { AutomationRunStatus } from '../../shared/types/automation.types';
import type { Instance } from '../../shared/types/instance.types';

/**
 * The slice of InstanceManager these stamps need. `queueInstanceUpdate` is
 * optional so narrower sources (the mobile gateway's) can pass through; the
 * real InstanceManager always provides it.
 */
interface OutcomeManager {
  getInstance(instanceId: string): Instance | undefined;
  queueInstanceUpdate?(instanceId: string, update: Record<string, never>): void;
}

/**
 * Record how a hidden automation's run ended on its still-live instance. No-op
 * for visible automations and for instances that are already gone.
 *
 * Success: durably record the *good* outcome. Archival hides a hidden
 * automation's thread only when `automationRunSucceeded` is present, so every
 * other ending (failed, cancelled, killed mid-run at app shutdown) leaves the
 * thread visible in the project rail.
 *
 * Recording success rather than failure for archival is deliberate, and the
 * ordering is why. `InstanceTerminationCoordinator.terminateInstance` awaits
 * `archiveRootConversation` *before* it transitions the instance to
 * `terminated` or emits `removed`, the two events that would tell the runner
 * the run had ended badly. A failure stamp therefore always lands after the
 * archived entry has already been written, and `archiveInstance` never
 * re-archives the same instance. Marking success instead means the unknown
 * state is the visible one: a hidden automation killed mid-run by
 * `terminateAll()` on app quit stays in the rail. The archived entry cannot
 * work this out for itself, because termination maps every non-`error` status
 * to the `completed` ConversationEndStatus.
 *
 * Any other ending reveals the session (see {@link revealHiddenAutomationSession}).
 */
export function stampHiddenAutomationOutcome(
  manager: OutcomeManager | null,
  instanceId: string,
  status: Exclude<AutomationRunStatus, 'pending' | 'running'>,
): void {
  if (status !== 'succeeded') {
    revealHiddenAutomationSession(manager, instanceId);
    return;
  }
  const instance = manager?.getInstance(instanceId);
  if (!instance || instance.metadata?.['automationHidden'] !== true) {
    return;
  }
  instance.metadata = { ...instance.metadata, automationRunSucceeded: true };
}

/**
 * Stamp `automationRevealed` on a live hidden-automation session so the project
 * rail keeps showing it whatever its status, and archival stops treating it as
 * hidden. Sticky and idempotent; no-op for any other session.
 *
 * Called when hiding stops being safe:
 * - its run ended without a clean success (otherwise restarting a failed
 *   session to carry on with it made the session vanish from the rail);
 * - its automation was deleted mid-run, so no outcome will ever be recorded;
 * - the operator took the session over (sent input, a command, or restarted it).
 *
 * The re-broadcast lets the renderer learn the stamp even when the status does
 * not change (an idle provider-limit reclassification, an operator send), since
 * the renderer only receives metadata when an instance is created.
 */
export function revealHiddenAutomationSession(
  manager: OutcomeManager | null,
  instanceId: string,
): void {
  const instance = manager?.getInstance(instanceId);
  if (
    !manager
    || !instance
    || instance.metadata?.['automationHidden'] !== true
    || instance.metadata['automationRevealed'] === true
  ) {
    return;
  }
  instance.metadata = { ...instance.metadata, automationRevealed: true };
  manager.queueInstanceUpdate?.(instanceId, {});
}
