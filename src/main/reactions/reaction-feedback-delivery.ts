/**
 * Admission-gated delivery of reaction feedback into an agent session.
 *
 * A5: re-checks live instance state (waiting_for_permission/interrupting/
 * respawning/quota-parked/...) immediately before sending. No redelivery
 * handler is registered for 'reaction' — reaction feedback is tied to a
 * specific CI/PR event snapshot; the reaction engine re-evaluates fresh on
 * the next webhook/poll cycle, so replaying a stale nudge once the instance
 * eventually settles risks confusing the agent about state that has since
 * moved on. A suppressed reaction is simply dropped (logged).
 */

import { getLogger } from '../logging/logger';
import { getSessionAdmissionService } from '../session/session-admission-service';
import type { InstanceManager } from '../instance/instance-manager';

const logger = getLogger('ReactionEngine');

export async function deliverAdmittedReactionFeedback(
  instanceManager: InstanceManager,
  instanceId: string,
  message: string,
): Promise<boolean> {
  const admission = getSessionAdmissionService();
  const outcome = admission.admitAutomatedWrite({ instanceId, origin: 'reaction', message });
  if (outcome.kind === 'suppressed') {
    logger.info('Reaction feedback suppressed pending instance readiness', {
      instanceId,
      reason: outcome.reason,
      admissionId: outcome.admissionId,
    });
    return false;
  }

  try {
    await instanceManager.sendInput(instanceId, message);
    admission.markDelivered(outcome.admissionId);
    logger.info('Sent reaction feedback to agent', {
      instanceId,
      messagePreview: message.slice(0, 120),
    });
    return true;
  } catch (err) {
    admission.markFailed(outcome.admissionId, err instanceof Error ? err.message : String(err));
    logger.error(
      'Failed to send reaction to agent',
      err instanceof Error ? err : new Error(String(err)),
      { instanceId },
    );
    return false;
  }
}
